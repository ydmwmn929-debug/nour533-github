(() => {
  const config = window.NOUR_FIREBASE_CONFIG || {};
  const configured = Boolean(config.apiKey && config.authDomain && config.projectId && config.appId && window.firebase);
  const workspacePath = 'workspaces/main';
  const fullPermissions = ['dashboard', 'pos', 'inventory', 'stock-transfers', 'inventory-movements', 'products', 'product-merges', 'invoices', 'reports', 'money-expenses', 'customers', 'suppliers', 'receipts', 'returns', 'inventory-sheet', 'daily-stocktake', 'locations', 'ai-forecast', 'settings'];
  const allowedRoles = new Set(['admin', 'receipts', 'cashier', 'inventory', 'custom']);
  const chunkSize = 400_000;
  const batchSize = 20;
  const maximumChunks = 450;
  let app = null;
  let auth = null;
  let database = null;
  let profile = null;
  let workspaceVersion = null;
  let lastSavedSnapshotJson = null;
  let saveQueue = Promise.resolve();
  let authReady = Promise.resolve(null);

  try {
    localStorage.removeItem('nour_erp_cloud_session');
  } catch (error) {
    console.warn('Could not remove the retired cloud session cache:', error);
  }

  if (configured) {
    app = window.firebase.apps.length ? window.firebase.app() : window.firebase.initializeApp(config);
    auth = app.auth();
    database = app.firestore();
    authReady = auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL)
      .catch(error => console.warn('Could not set persistent Firebase sign-in:', error))
      .then(() => new Promise(resolve => {
        let unsubscribe = () => {};
        unsubscribe = auth.onAuthStateChanged(user => {
          unsubscribe();
          resolve(user);
        }, () => resolve(null));
      }));
  }

  function translateError(error) {
    if (error?.code === 'workspace_data_conflict') {
      const translated = new Error('تعارضت تعديلات متزامنة على السجل نفسه. لم يتم استبدال نسخة الجهاز الآخر؛ احتفظ بنسخة من تعديلاتك قبل إعادة التحميل.');
      translated.code = error.code;
      return translated;
    }
    if (error?.code === 'workspace_sync_busy') {
      const translated = new Error('تحديثات متزامنة كثيرة. بياناتك المحلية محفوظة؛ انتظر قليلًا ثم حاول المزامنة مجددًا.');
      translated.code = error.code;
      return translated;
    }
    const messages = {
      'auth/email-already-in-use': 'اسم المستخدم مسجل بالفعل.',
      'auth/invalid-credential': 'اسم المستخدم أو كلمة المرور غير صحيحة.',
      'auth/invalid-login-credentials': 'اسم المستخدم أو كلمة المرور غير صحيحة.',
      'auth/invalid-email': 'بيانات تسجيل الدخول غير صحيحة.',
      'auth/network-request-failed': 'تعذر الاتصال بخدمات Firebase. تحقق من الإنترنت.',
      'auth/operation-not-allowed': 'تسجيل البريد وكلمة المرور غير مفعّل في Firebase Authentication.',
      'auth/too-many-requests': 'محاولات كثيرة؛ انتظر قليلًا ثم أعد المحاولة.',
      'auth/wrong-password': 'اسم المستخدم أو كلمة المرور غير صحيحة.',
      'permission-denied': 'ليست لديك صلاحية الوصول إلى بيانات الشركة.',
      'unavailable': 'Firebase غير متاح مؤقتًا؛ ستتم إعادة المحاولة.'
    };
    if (messages[error?.code]) return new Error(messages[error.code]);
    const message = String(error?.message || 'حدث خطأ غير متوقع في Firebase.');
    if (/workspace_version_conflict/i.test(message)) return new Error('تم تحديث بيانات الشركة من جهاز آخر؛ أعد تحميل الصفحة قبل الحفظ.');
    return new Error(message.replace(/^FirebaseError:\s*/i, ''));
  }

  function ensureConfigured() {
    if (!configured) throw new Error('أكمل إعدادات Firebase في firebase-config.js ثم أعد نشر الموقع.');
  }

  function ensureSignedIn() {
    ensureConfigured();
    if (!auth.currentUser) throw new Error('يجب تسجيل الدخول أولًا.');
    return auth.currentUser;
  }

  function ensureAdministrator() {
    ensureSignedIn();
    if (profile?.role !== 'admin') throw new Error('صلاحية المدير العام مطلوبة.');
  }

  async function toAuthEmail(username) {
    const normalized = String(username || '').trim().toLowerCase();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    return `u${hash.slice(0, 32)}@users.nourgroup.app`;
  }

  function currentUserId() {
    return auth?.currentUser?.uid || '';
  }

  function memberPath(userId) {
    return `${workspacePath}/members/${userId}`;
  }

  function memberFromData(userId, member) {
    return {
      ...member,
      id: userId,
      user_id: userId,
      workspace_id: 'main',
      username: String(member.username || ''),
      role: String(member.role || ''),
      permissions: Array.isArray(member.permissions) ? member.permissions : [],
      image: String(member.image || ''),
      active: member.active !== false,
      expiresAt: member.expiresAt?.toDate?.().toISOString() || member.expiresAt || null
    };
  }

  async function refreshAccountCache() {
    if (profile?.role !== 'admin') return;
    try {
      const members = await database.collection(`${workspacePath}/members`).orderBy('createdAt').get();
      const accounts = members.docs
        .map(document => memberFromData(document.id, document.data()))
        .filter(account => account.id !== currentUserId() && account.active);
      localStorage.setItem('nour_erp_user_accounts', JSON.stringify(accounts));
    } catch (error) {
      console.warn('Could not refresh the optional local account cache:', error);
    }
  }

  async function loadProfile() {
    const userId = currentUserId();
    if (!userId) return null;
    try {
      const memberSnapshot = await database.doc(memberPath(userId)).get();
      if (!memberSnapshot.exists) {
        await auth.signOut();
        throw new Error('هذا الحساب غير مرتبط بمساحة عمل. تواصل مع المدير العام.');
      }
      const member = memberSnapshot.data();
      if (member.active === false) {
        await auth.signOut();
        throw new Error('تم تعطيل هذا الحساب. تواصل مع المدير العام.');
      }
      if (member.expiresAt?.toDate && member.expiresAt.toDate().getTime() <= Date.now()) {
        await auth.signOut();
        throw new Error('انتهت مدة صلاحية هذا الحساب. تواصل مع مدير النظام.');
      }
      profile = memberFromData(userId, member);
      await refreshAccountCache();
      return profile;
    } catch (error) {
      if (error.message?.includes('غير مرتبط')) throw error;
      throw translateError(error);
    }
  }

  function splitSnapshot(json) {
    const chunks = [];
    let chunk = '';
    let bytes = 0;
    for (const character of json) {
      const characterBytes = new TextEncoder().encode(character).length;
      if (bytes + characterBytes > chunkSize && chunk) {
        chunks.push(chunk);
        chunk = '';
        bytes = 0;
      }
      chunk += character;
      bytes += characterBytes;
    }
    if (chunk || !chunks.length) chunks.push(chunk);
    if (chunks.length > maximumChunks) throw new Error('بيانات الشركة تتجاوز السعة المدعومة في Firebase.');
    return chunks;
  }

  function snapshotRef(snapshotId) {
    return database.doc(`${workspacePath}/snapshots/${snapshotId}`);
  }

  function snapshotChunkCollection(snapshotId) {
    return database.collection(`${workspacePath}/snapshots/${snapshotId}/chunks`);
  }

  async function writeSnapshotChunks(snapshotId, chunks) {
    const collection = snapshotChunkCollection(snapshotId);
    for (let offset = 0; offset < chunks.length; offset += batchSize) {
      const batch = database.batch();
      chunks.slice(offset, offset + batchSize).forEach((payload, localIndex) => {
        const index = offset + localIndex;
        batch.set(collection.doc(String(index).padStart(4, '0')), { index, payload });
      });
      await batch.commit();
    }
  }

  async function readWorkspaceSnapshot(workspace) {
    if (!workspace.snapshotId) return {};
    const chunks = await snapshotChunkCollection(workspace.snapshotId).orderBy('index').get();
    const json = chunks.docs.map(document => String(document.data().payload || '')).join('');
    try {
      return JSON.parse(json || '{}');
    } catch (error) {
      throw new Error('تعذر قراءة بيانات الشركة المحفوظة في Firebase.');
    }
  }

  async function deleteSnapshot(snapshotId) {
    const chunks = await snapshotChunkCollection(snapshotId).get();
    for (let offset = 0; offset < chunks.docs.length; offset += 400) {
      const batch = database.batch();
      chunks.docs.slice(offset, offset + 400).forEach(document => batch.delete(document.ref));
      await batch.commit();
    }
    await snapshotRef(snapshotId).delete();
  }

  async function cleanupOldSnapshots(activeSnapshotId) {
    if (profile?.role !== 'admin') return;
    const cleanupKey = 'nour_erp_firebase_cleanup_at';
    if (Date.now() - Number(localStorage.getItem(cleanupKey) || 0) < 6 * 60 * 60 * 1000) return;
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const oldSnapshots = await database.collection(`${workspacePath}/snapshots`).where('createdAt', '<', cutoff).limit(20).get();
      for (const snapshot of oldSnapshots.docs) {
        if (snapshot.id !== activeSnapshotId) await deleteSnapshot(snapshot.id);
      }
      localStorage.setItem(cleanupKey, String(Date.now()));
    } catch (error) {
      console.warn('Could not clean old Firebase snapshots:', error);
    }
  }

  function cleanSnapshot(snapshot) {
    const clean = JSON.parse(JSON.stringify(snapshot || {}));
    if (clean.settings) {
      const { password, ...safeLogin } = clean.settings.login || {};
      if (Object.keys(safeLogin).length) clean.settings.login = safeLogin;
      else delete clean.settings.login;
      delete clean.settings.accounts;
    }
    return clean;
  }

  function serializeSnapshot(snapshot) {
    return JSON.stringify(snapshot, (key, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      return Object.keys(value).sort().reduce((sorted, property) => {
        sorted[property] = value[property];
        return sorted;
      }, {});
    });
  }

  async function workspaceExists() {
    ensureConfigured();
    return (await database.doc(workspacePath).get()).exists;
  }

  async function restoreSession() {
    if (!configured) return null;
    await authReady;
    if (!auth.currentUser) return null;
    try {
      return await loadProfile();
    } catch (error) {
      console.error('Firebase profile load failed:', error);
      profile = null;
      return null;
    }
  }

  async function signIn(username, password) {
    ensureConfigured();
    try {
      await auth.signInWithEmailAndPassword(await toAuthEmail(username), password);
      return await loadProfile();
    } catch (error) {
      if (error.message?.includes('غير مرتبط')) throw error;
      throw translateError(error);
    }
  }

  async function requestAccountAccess(username, password) {
    ensureConfigured();
    if (!(await workspaceExists())) throw new Error('إعداد مساحة العمل غير مكتمل.');
    const normalizedUsername = String(username || '').trim();
    if (!/^[\p{L}\p{N}._ -]{3,40}$/u.test(normalizedUsername) || String(password || '').length < 8) {
      throw new Error('اسم المستخدم أو كلمة المرور غير صالحة.');
    }

    let requestUserId = '';
    try {
      const email = await toAuthEmail(normalizedUsername);
      try {
        const credential = await auth.createUserWithEmailAndPassword(email, String(password));
        requestUserId = credential.user.uid;
      } catch (error) {
        if (error.code !== 'auth/email-already-in-use') throw error;
        const credential = await auth.signInWithEmailAndPassword(email, String(password));
        requestUserId = credential.user.uid;
      }

      const requestRef = database.doc(`${workspacePath}/accessRequests/${requestUserId}`);
      const existingRequest = await requestRef.get();
      const requestData = {
        username: normalizedUsername,
        usernameKey: normalizedUsername.toLowerCase(),
        status: 'pending',
        createdAt: window.firebase.firestore.FieldValue.serverTimestamp()
      };
      if (existingRequest.exists) {
        if (existingRequest.data().status !== 'rejected') {
          throw new Error('يوجد طلب سابق لهذا الحساب أو أن الحساب مفعّل بالفعل.');
        }
        await requestRef.update({ status: 'pending', createdAt: requestData.createdAt });
      } else {
        await requestRef.set(requestData);
      }
    } catch (error) {
      throw translateError(error);
    } finally {
      await auth.signOut();
      profile = null;
    }
  }

  async function bootstrap(username, password, snapshot) {
    ensureConfigured();
    if (String(username).trim().toLowerCase() !== 'nour') throw new Error('اسم أول مدير للشركة يجب أن يكون nour.');
    if (await workspaceExists()) throw new Error('تم إعداد مساحة عمل بالفعل. سجّل الدخول بحساب المدير العام.');

    let credential;
    let createdAccount = false;
    try {
      const email = await toAuthEmail(username);
      try {
        credential = await auth.createUserWithEmailAndPassword(email, password);
        createdAccount = true;
      } catch (error) {
        if (error.code !== 'auth/email-already-in-use') throw error;
        credential = await auth.signInWithEmailAndPassword(email, password);
      }
      const userId = credential.user.uid;
      const cleanedSnapshot = cleanSnapshot(snapshot);
      const snapshotJson = serializeSnapshot(cleanedSnapshot);
      const chunks = splitSnapshot(snapshotJson);
      const snapshotId = `initial-${userId}`;
      const member = {
        username: 'nour',
        usernameKey: 'nour',
        role: 'admin',
        permissions: fullPermissions,
        image: '',
        active: true,
        createdAt: window.firebase.firestore.FieldValue.serverTimestamp()
      };
      const batch = database.batch();
      batch.set(database.doc(workspacePath), {
        createdBy: userId,
        snapshotId,
        version: 1,
        createdAt: window.firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
      });
      batch.set(database.doc(memberPath(userId)), member);
      batch.set(snapshotRef(snapshotId), {
        ownerUid: userId,
        chunkCount: chunks.length,
        createdAt: window.firebase.firestore.FieldValue.serverTimestamp()
      });
      chunks.forEach((payload, index) => {
        batch.set(snapshotChunkCollection(snapshotId).doc(String(index).padStart(4, '0')), { index, payload });
      });
      await batch.commit();
      profile = memberFromData(userId, member);
      workspaceVersion = 1;
      lastSavedSnapshotJson = snapshotJson;
      return profile;
    } catch (error) {
      if (createdAccount && auth.currentUser) await auth.currentUser.delete().catch(() => {});
      await auth.signOut().catch(() => {});
      throw translateError(error);
    }
  }

  async function loadAppData() {
    if (!configured || !auth.currentUser) return null;
    if (!profile) await loadProfile();
    try {
      const workspaceSnapshot = await database.doc(workspacePath).get();
      if (!workspaceSnapshot.exists) return null;
      const workspace = workspaceSnapshot.data();
      const data = await readWorkspaceSnapshot(workspace);
      workspaceVersion = Number(workspace.version);
      if (!Number.isInteger(workspaceVersion) || workspaceVersion < 1) throw new Error('إصدار بيانات الشركة غير صالح في Firebase.');
      lastSavedSnapshotJson = serializeSnapshot(cleanSnapshot(data));
      void cleanupOldSnapshots(workspace.snapshotId);
      return data;
    } catch (error) {
      throw translateError(error);
    }
  }

  async function hasAppDataUpdate() {
    if (!configured || !auth.currentUser || !Number.isInteger(workspaceVersion)) return false;
    try {
      const snapshot = await database.doc(workspacePath).get();
      if (!snapshot.exists) throw new Error('تعذر العثور على مساحة عمل الشركة في Firebase.');
      return Number(snapshot.data().version) > workspaceVersion;
    } catch (error) {
      throw translateError(error);
    }
  }

  function saveAppData(snapshot) {
    if (!configured || !auth.currentUser) return Promise.resolve(false);
    const operation = saveQueue.then(async () => {
      if (!profile) await loadProfile();
      const workspaceRef = database.doc(workspacePath);
      let candidate = cleanSnapshot(snapshot);
      let base = lastSavedSnapshotJson ? JSON.parse(lastSavedSnapshotJson) : null;
      let baseVersion = workspaceVersion;
      let merged = false;

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const currentWorkspace = await workspaceRef.get();
        if (!currentWorkspace.exists) throw new Error('تعذر العثور على مساحة عمل الشركة في Firebase.');
        const currentVersion = Number(currentWorkspace.data().version);
        if (!Number.isInteger(currentVersion) || currentVersion < 1) {
          throw new Error('إصدار بيانات الشركة غير صالح في Firebase.');
        }

        const remote = base && currentVersion === baseVersion
          ? base
          : cleanSnapshot(await readWorkspaceSnapshot(currentWorkspace.data()));
        if (!base) {
          base = cleanSnapshot(remote);
          baseVersion = currentVersion;
        }
        if (currentVersion !== baseVersion) {
          const mergeResult = window.nourSnapshotMerge?.(base, candidate, remote);
          if (!mergeResult) throw new Error('تعذر تحميل أداة دمج البيانات المتزامنة.');
          if (mergeResult.conflicts.length) {
            const error = new Error('workspace_data_conflict');
            error.code = 'workspace_data_conflict';
            error.conflicts = mergeResult.conflicts;
            throw translateError(error);
          }
          candidate = cleanSnapshot(mergeResult.snapshot);
          base = cleanSnapshot(remote);
          baseVersion = currentVersion;
          merged = true;
        }

        const snapshotJson = serializeSnapshot(candidate);
        if (snapshotJson === serializeSnapshot(cleanSnapshot(remote))) {
          workspaceVersion = currentVersion;
          lastSavedSnapshotJson = snapshotJson;
          return { saved: false, merged, snapshot: candidate };
        }

        const snapshotId = `${auth.currentUser.uid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const chunks = splitSnapshot(snapshotJson);
        try {
          await snapshotRef(snapshotId).set({
            ownerUid: auth.currentUser.uid,
            chunkCount: chunks.length,
            createdAt: window.firebase.firestore.FieldValue.serverTimestamp()
          });
          await writeSnapshotChunks(snapshotId, chunks);
          const nextVersion = currentVersion + 1;
          await database.runTransaction(async transaction => {
            const freshWorkspace = await transaction.get(workspaceRef);
            if (!freshWorkspace.exists || Number(freshWorkspace.data().version) !== currentVersion) {
              throw new Error('workspace_version_conflict');
            }
            transaction.update(workspaceRef, {
              snapshotId,
              version: nextVersion,
              updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
            });
          });
          workspaceVersion = nextVersion;
          lastSavedSnapshotJson = snapshotJson;
          void cleanupOldSnapshots(snapshotId);
          return { saved: true, merged, snapshot: candidate };
        } catch (error) {
          await deleteSnapshot(snapshotId).catch(() => {});
          if (!/workspace_version_conflict/i.test(String(error?.message || ''))) {
            throw translateError(error);
          }
          base = cleanSnapshot(remote);
          baseVersion = currentVersion;
          merged = true;
        }
      }

      const error = new Error('workspace_sync_busy');
      error.code = 'workspace_sync_busy';
      throw translateError(error);
    });
    saveQueue = operation.catch(() => {});
    return operation;
  }

  async function signOut() {
    try {
      if (auth) await auth.signOut();
    } finally {
      profile = null;
      workspaceVersion = null;
      lastSavedSnapshotJson = null;
    }
  }

  async function verifyPassword(username, password) {
    const user = ensureSignedIn();
    try {
      const credential = window.firebase.auth.EmailAuthProvider.credential(await toAuthEmail(username), password);
      await user.reauthenticateWithCredential(credential);
    } catch (error) {
      if (['auth/wrong-password', 'auth/invalid-credential', 'auth/invalid-login-credentials'].includes(error.code)) throw new Error('كلمة المرور الحالية غير صحيحة.');
      throw translateError(error);
    }
  }

  async function updatePassword(password) {
    try {
      await ensureSignedIn().updatePassword(password);
    } catch (error) {
      throw translateError(error);
    }
  }

  async function createAccount(account) {
    ensureAdministrator();
    const username = String(account.username || '').trim();
    const role = String(account.role || '');
    if (!/^[\p{L}\p{N}._ -]{3,40}$/u.test(username) || !allowedRoles.has(role)) throw new Error('اسم المستخدم أو الدور غير صالح.');
    const permissions = role === 'admin' ? fullPermissions : account.permissions;
    if (role !== 'admin' && (!Array.isArray(permissions) || !permissions.length)) throw new Error('اختر صلاحية واحدة على الأقل.');

    const secondaryApp = window.firebase.initializeApp(config, `nour-account-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    const secondaryAuth = secondaryApp.auth();
    let createdUser;
    try {
      await secondaryAuth.setPersistence(window.firebase.auth.Auth.Persistence.NONE);
      const credential = await secondaryAuth.createUserWithEmailAndPassword(await toAuthEmail(username), String(account.password || ''));
      createdUser = credential.user;
      const member = {
        username,
        usernameKey: username.toLowerCase(),
        role,
        permissions,
        image: String(account.image || ''),
        active: true,
        createdAt: window.firebase.firestore.FieldValue.serverTimestamp()
      };
      await database.doc(memberPath(createdUser.uid)).set(member);
      await refreshAccountCache();
      return memberFromData(createdUser.uid, { ...member, createdAt: null });
    } catch (error) {
      if (createdUser) await createdUser.delete().catch(() => {});
      throw translateError(error);
    } finally {
      await secondaryAuth.signOut().catch(() => {});
      await secondaryApp.delete().catch(() => {});
    }
  }

  async function updateProfileImage(image) {
    const userId = currentUserId();
    const value = String(image || '');
    if (value.length > 1_000_000 || (value && !value.startsWith('data:image/'))) throw new Error('صورة الحساب غير صالحة.');
    await database.doc(memberPath(userId)).update({ image: value });
    profile = { ...profile, image: value };
    return profile;
  }

  async function deleteAccount(userId) {
    ensureAdministrator();
    if (!userId || userId === currentUserId()) throw new Error('لا يمكن حذف حساب المدير الحالي.');
    await database.doc(memberPath(String(userId))).update({ active: false });
    await refreshAccountCache();
  }

  async function listAccessRequests() {
    ensureAdministrator();
    const requests = await database.collection(`${workspacePath}/accessRequests`).get();
    return requests.docs
      .filter(document => document.data().status === 'pending')
      .map(document => {
        const data = document.data();
        return {
          id: document.id,
          username: String(data.username || ''),
          created_at: data.createdAt?.toDate?.().toISOString() || ''
        };
      })
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  async function approveAccessRequest(requestId, permissions, days) {
    ensureAdministrator();
    const selectedPermissions = [...new Set(permissions || [])];
    if (!requestId || !selectedPermissions.length
      || selectedPermissions.some(permission => !fullPermissions.includes(permission))) {
      throw new Error('صلاحيات الطلب المحددة غير صالحة.');
    }
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new Error('مدة الحساب يجب أن تكون من يوم إلى 3650 يومًا.');
    }

    const requestRef = database.doc(`${workspacePath}/accessRequests/${String(requestId)}`);
    const memberRef = database.doc(memberPath(String(requestId)));
    const expiresAt = window.firebase.firestore.Timestamp.fromDate(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
    try {
      await database.runTransaction(async transaction => {
        const requestSnapshot = await transaction.get(requestRef);
        const memberSnapshot = await transaction.get(memberRef);
        if (!requestSnapshot.exists || requestSnapshot.data().status !== 'pending') {
          throw new Error('هذا الطلب لم يعد معلقًا.');
        }
        if (memberSnapshot.exists) throw new Error('يوجد حساب مستخدم مرتبط بهذا الطلب بالفعل.');
        const request = requestSnapshot.data();
        const member = {
          username: String(request.username),
          usernameKey: String(request.usernameKey),
          role: 'custom',
          permissions: selectedPermissions,
          image: '',
          active: true,
          createdAt: window.firebase.firestore.FieldValue.serverTimestamp(),
          expiresAt
        };
        transaction.set(memberRef, member);
        transaction.update(requestRef, {
          status: 'approved',
          permissions: selectedPermissions,
          expiresAt,
          reviewedBy: currentUserId(),
          reviewedAt: window.firebase.firestore.FieldValue.serverTimestamp()
        });
      });
      await refreshAccountCache();
    } catch (error) {
      throw translateError(error);
    }
  }

  async function rejectAccessRequest(requestId) {
    ensureAdministrator();
    if (!requestId) throw new Error('معرّف الطلب غير صالح.');
    const requestRef = database.doc(`${workspacePath}/accessRequests/${String(requestId)}`);
    try {
      await database.runTransaction(async transaction => {
        const requestSnapshot = await transaction.get(requestRef);
        if (!requestSnapshot.exists || requestSnapshot.data().status !== 'pending') {
          throw new Error('هذا الطلب لم يعد معلقًا.');
        }
        transaction.update(requestRef, {
          status: 'rejected',
          reviewedBy: currentUserId(),
          reviewedAt: window.firebase.firestore.FieldValue.serverTimestamp()
        });
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  async function listOrders() {
    ensureAdministrator();
    const orders = await database.collection(`${workspacePath}/onlineOrders`).orderBy('created_at', 'desc').get();
    return orders.docs.map(document => {
      const data = document.data();
      return { id: document.id, ...data, created_at: data.created_at?.toDate?.().toISOString() || String(data.created_at || '') };
    });
  }

  async function updateOrder(orderId, changes) {
    ensureAdministrator();
    const updates = {};
    if (changes?.status) updates.status = String(changes.status);
    for (const key of ['approved_at', 'expires_at']) {
      if (Object.hasOwn(changes || {}, key)) updates[key] = changes[key] ? new Date(changes[key]) : null;
    }
    updates.updated_at = window.firebase.firestore.FieldValue.serverTimestamp();
    await database.doc(`${workspacePath}/onlineOrders/${String(orderId)}`).update(updates);
  }

  if (!window.nourMail) {
    window.nourMail = {
      loadAppData,
      saveAppData,
      flushAppData: data => { void saveAppData(data).catch(error => console.error('Firebase flush failed:', error)); }
    };
  }

  window.nourCloud = {
    configured,
    restoreSession,
    signIn,
    signOut,
    bootstrap,
    requestAccountAccess,
    workspaceExists,
    loadAppData,
    hasAppDataUpdate,
    saveAppData,
    flushAppData: data => { void saveAppData(data).catch(error => console.error('Firebase flush failed:', error)); },
    updatePassword,
    verifyPassword,
    createAccount,
    updateProfileImage,
    deleteAccount,
    listAccessRequests,
    approveAccessRequest,
    rejectAccessRequest,
    listOrders,
    updateOrder,
    getProfile: () => profile,
    getLastSavedSnapshot: () => lastSavedSnapshotJson ? JSON.parse(lastSavedSnapshotJson) : null,
    isAdministrator: () => profile?.role === 'admin'
  };
})();
