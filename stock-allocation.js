(() => {
  function dateValue(value) {
    if (!value) return Number.POSITIVE_INFINITY;
    const timestamp = Date.parse(String(value));
    return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
  }

  function allocateStockLots(candidates, requestedQuantity) {
    const quantity = Number(requestedQuantity);
    if (!Number.isInteger(quantity) || quantity <= 0) return null;

    const available = candidates
      .map((candidate, index) => ({
        ...candidate,
        quantity: Math.max(0, Math.floor(Number(candidate.quantity) || 0)),
        index
      }))
      .filter(candidate => candidate.quantity > 0)
      .sort((first, second) =>
        dateValue(first.expiryDate) - dateValue(second.expiryDate)
        || dateValue(first.receivedDate) - dateValue(second.receivedDate)
        || first.index - second.index);

    if (available.reduce((sum, candidate) => sum + candidate.quantity, 0) < quantity) return null;

    let remaining = quantity;
    return available.flatMap(candidate => {
      if (!remaining) return [];
      const allocatedQuantity = Math.min(remaining, candidate.quantity);
      remaining -= allocatedQuantity;
      return [{ ...candidate, quantity: allocatedQuantity }];
    });
  }

  const api = { allocateStockLots };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.nourStockAllocation = api;
})();
