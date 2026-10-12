import { PurchaseRequisition } from './purchaseRequisition.model.js';
import { PurchaseOrder } from './purchaseOrder.model.js';
import { GoodsReceipt } from './goodsReceipt.model.js';
import { PO_OPEN_STATUSES, PR_OPEN_STATUSES } from './purchase.defaults.js';

/** GRN states where goods are physically in but not yet stock (QC not done). */
const GRN_PENDING_STATUSES = ['DRAFT', 'PENDING_QC'];

/**
 * Quantity per material that is already requested / ordered / awaiting QC, i.e. expected to
 * become stock without raising another PR:
 *   open PRs (DRAFT/SUBMITTED/APPROVED) requiredQty
 * + open POs (APPROVED/SENT/PARTIAL) max(0, ordered − received)   (received is net of QC rejects)
 * + GRNs in DRAFT/PENDING_QC receivedQty                           (arrived, not yet accepted)
 *
 * Models only (no service imports) so inventory / MRP can use it without import cycles.
 *
 * @param {string|ObjectId} factoryId
 * @param {{ materialIds?: Array<string|ObjectId>, prIds?: Array<string|ObjectId> }} [opts]
 *   prIds restricts the calculation to those PRs and the POs/GRNs created from them.
 * @returns {Promise<Map<string, number>>} materialId → qty
 */
export async function computeOnOrderByMaterial(factoryId, { materialIds, prIds } = {}) {
  const out = new Map();
  if (prIds && !prIds.length) return out;
  const wanted = materialIds ? new Set(materialIds.map((id) => String(id))) : null;
  const add = (materialId, qty) => {
    const key = String(materialId);
    if (!qty || qty <= 0 || (wanted && !wanted.has(key))) return;
    out.set(key, (out.get(key) || 0) + qty);
  };
  const matFilter = materialIds ? { 'lines.materialId': { $in: materialIds } } : {};

  const prQuery = { factoryId, isDeleted: false, status: { $in: PR_OPEN_STATUSES }, ...matFilter };
  if (prIds) prQuery._id = { $in: prIds };

  const poQuery = { factoryId, isDeleted: false, status: { $in: PO_OPEN_STATUSES }, ...matFilter };
  if (prIds) poQuery.prId = { $in: prIds };

  const grnQuery = { factoryId, isDeleted: false, status: { $in: GRN_PENDING_STATUSES }, ...matFilter };
  if (prIds) {
    const poIds = await PurchaseOrder.find({
      factoryId, isDeleted: false, prId: { $in: prIds }, status: { $ne: 'CANCELLED' },
    }).distinct('_id');
    if (!poIds.length) grnQuery._id = { $in: [] };
    else grnQuery.poId = { $in: poIds };
  }

  const [prs, pos, grns] = await Promise.all([
    PurchaseRequisition.find(prQuery).select('lines.materialId lines.requiredQty').lean(),
    PurchaseOrder.find(poQuery).select('lines.materialId lines.orderedQty lines.receivedQty').lean(),
    GoodsReceipt.find(grnQuery).select('lines.materialId lines.receivedQty').lean(),
  ]);

  for (const pr of prs) {
    for (const line of pr.lines || []) add(line.materialId, line.requiredQty || 0);
  }
  for (const po of pos) {
    for (const line of po.lines || []) {
      add(line.materialId, Math.max(0, (line.orderedQty || 0) - (line.receivedQty || 0)));
    }
  }
  for (const grn of grns) {
    for (const line of grn.lines || []) add(line.materialId, line.receivedQty || 0);
  }
  return out;
}
