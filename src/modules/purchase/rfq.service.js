import { Rfq } from './rfq.model.js';
import { Quotation } from './quotation.model.js';
import { PurchaseRequisition } from './purchaseRequisition.model.js';
import { Factory } from '../organization/factory.model.js';
import { createPurchaseOrder } from './purchase.service.js';
import { nextDocumentNumber } from '../../shared/utils/numbering.js';
import { NotFoundError, ConflictError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';
import { notifyUserByEmail } from '../notification/notification.service.js';

export async function createRfqFromPr({ factoryId, organizationId, prId, supplierIds }, userId) {
  const pr = await PurchaseRequisition.findOne(applySoftDeleteFilter({ _id: prId, factoryId }));
  if (!pr) throw new NotFoundError('PR not found');
  if (pr.status !== 'APPROVED') throw new ConflictError('PR must be APPROVED');

  const factory = await Factory.findById(factoryId);
  const rfqNumber = await nextDocumentNumber(factoryId, 'RFQ', `RFQ-${factory.code}-`);

  const lines = pr.lines.map((l) => ({
    materialId: l.materialId,
    quantity: l.requiredQty,
    unit: l.unit,
  }));

  return Rfq.create({
    organizationId,
    factoryId,
    rfqNumber,
    prId: pr._id,
    supplierIds: supplierIds || [],
    lines,
    status: 'DRAFT',
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function listRfqs(factoryId, { page, limit, skip, status, search }) {
  const filter = applySoftDeleteFilter({ factoryId });
  if (status) filter.status = status;
  if (search?.trim()) {
    const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.rfqNumber = re;
  }
  const [items, total] = await Promise.all([
    Rfq.find(filter)
      .populate('prId', 'prNumber')
      .populate('supplierIds', 'name supplierCode')
      .populate('lines.materialId', 'materialCode name unit')
      .skip(skip)
      .limit(limit)
      .sort({ updatedAt: -1 }),
    Rfq.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getRfq(id, factoryId) {
  const filter = applySoftDeleteFilter({ _id: id });
  if (factoryId) filter.factoryId = factoryId;
  const rfq = await Rfq.findOne(filter)
    .populate('prId', 'prNumber status')
    .populate('supplierIds', 'name supplierCode')
    .populate('lines.materialId', 'materialCode name unit');
  if (!rfq) throw new NotFoundError('RFQ not found');
  return rfq;
}

export async function sendRfq(id, factoryId, userId) {
  const rfq = await getRfq(id, factoryId);
  if (rfq.status !== 'DRAFT') throw new ConflictError('RFQ already sent');
  rfq.status = 'SENT';
  rfq.sentAt = new Date();
  rfq.updatedBy = userId;
  await rfq.save();
  return rfq;
}

export async function addQuotation({ rfqId, factoryId, supplierId, lines, validUntil }, userId) {
  const rfq = await getRfq(rfqId, factoryId);
  if (rfq.status === 'CLOSED') throw new ConflictError('RFQ is closed');

  return Quotation.create({
    organizationId: rfq.organizationId,
    factoryId: rfq.factoryId,
    rfqId: rfq._id,
    supplierId,
    lines,
    validUntil,
    createdBy: userId,
    updatedBy: userId,
  });
}

export async function compareQuotations(rfqId, factoryId) {
  const rfq = await getRfq(rfqId, factoryId);
  const quotes = await Quotation.find({ rfqId: rfq._id, isDeleted: false })
    .populate('supplierId', 'name supplierCode')
    .populate('lines.materialId', 'materialCode name unit');
  return quotes.sort((a, b) => a.totalAmount - b.totalAmount);
}

export async function selectQuotation(quotationId, factoryId, userId) {
  const quote = await Quotation.findOne({ _id: quotationId, factoryId, isDeleted: false });
  if (!quote) throw new NotFoundError('Quotation not found');

  await Quotation.updateMany({ rfqId: quote.rfqId }, { status: 'REJECTED' });
  quote.status = 'SELECTED';
  quote.updatedBy = userId;
  await quote.save();

  const rfq = await getRfq(quote.rfqId, factoryId);
  rfq.status = 'CLOSED';
  rfq.updatedBy = userId;
  await rfq.save();

  const lines = quote.lines.map((l) => ({
    materialId: l.materialId,
    orderedQty: l.quantity,
    unit: l.unit,
    unitPrice: l.unitPrice,
  }));

  const po = await createPurchaseOrder({
    factoryId: quote.factoryId,
    organizationId: quote.organizationId,
    supplierId: quote.supplierId,
    prId: rfq.prId,
    lines,
  }, userId);

  await notifyUserByEmail(userId, {
    subject: `PO created from RFQ ${rfq.rfqNumber}`,
    text: `Purchase order ${po.poNumber} created from selected quotation.`,
  });

  return { quotation: quote, purchaseOrder: po };
}
