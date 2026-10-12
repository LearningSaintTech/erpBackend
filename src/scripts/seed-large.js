/**
 * Large performance dataset, layered on top of the demo seed.
 *
 *   SAFETY: runs ONLY against a local MongoDB (localhost / 127.0.0.1 / ::1) — typically the
 *   in-memory server started by dev-memory.js. Any other URI (Atlas, mongodb+srv, a LAN host)
 *   is refused. The URI must be given explicitly; .env is never read.
 *
 *   npm run seed:large -- --uri=mongodb://127.0.0.1:27017/erp_perf
 *   SEED_LARGE=true npm run dev:mem          (in-memory API, demo seed + this dataset)
 *
 * Adds ≈ 2k materials · 200 suppliers · 3k designs · 5k SKUs · 600 BOMs · 1k PRs + 1k POs + 1k GRNs ·
 * 2k production orders (+ ~3k batches) · 8k inventory transactions + ~5k balances ·
 * 5k notifications · 3k approval instances · 5k audit logs. Uses insertMany (no hooks) for speed.
 */
import mongoose from 'mongoose';
import { Factory } from '../modules/organization/factory.model.js';
import { User } from '../modules/user/user.model.js';
import { Material } from '../modules/inventory/material.model.js';
import { Supplier } from '../modules/purchase/supplier.model.js';
import { Design } from '../modules/design/design.model.js';
import { Sku } from '../modules/sku/sku.model.js';
import { Bom } from '../modules/bom/bom.model.js';
import { PurchaseRequisition } from '../modules/purchase/purchaseRequisition.model.js';
import { PurchaseOrder } from '../modules/purchase/purchaseOrder.model.js';
import { GoodsReceipt } from '../modules/purchase/goodsReceipt.model.js';
import { ProductionOrder } from '../modules/production/productionOrder.model.js';
import { ProductionBatch } from '../modules/production/productionBatch.model.js';
import { InventoryTransaction } from '../modules/inventory/inventoryTransaction.model.js';
import { InventoryBalance } from '../modules/inventory/inventoryBalance.model.js';
import { Notification } from '../modules/notification/notification.model.js';
import { ApprovalInstance } from '../modules/approval/approvalInstance.model.js';
import { AuditLog } from '../modules/audit/audit.model.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True only for mongodb:// URIs whose every host is loopback. */
export function isLocalMongoUri(uri) {
  if (typeof uri !== 'string') return false;
  const m = /^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(uri.trim());
  if (!m) return false; // mongodb+srv and anything else → refuse
  const hosts = m[1].split(',').map((h) => {
    const host = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
    return host.toLowerCase();
  });
  return hosts.length > 0 && hosts.every((h) => LOCAL_HOSTS.has(h));
}

// Deterministic PRNG so runs are comparable.
let seed = 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pad = (n, w = 5) => String(n).padStart(w, '0');
const daysAgo = (d) => new Date(Date.now() - d * 86_400_000 - int(0, 86_399) * 1000);
const oid = () => new mongoose.Types.ObjectId();

async function insertChunks(Model, docs, size = 2000) {
  for (let i = 0; i < docs.length; i += size) {
    await Model.insertMany(docs.slice(i, i + size), { ordered: false, lean: true });
  }
  return docs.length;
}

const MAT_CATS = [
  ['FABRIC', 'METERS', ['Cotton poplin', 'Linen blend', 'Denim 12oz', 'Viscose rayon', 'Polyester crepe', 'Jersey knit', 'Twill', 'Chambray']],
  ['THREAD', 'CONES', ['Poly thread', 'Cotton thread', 'Core-spun thread']],
  ['BUTTON', 'PIECES', ['Horn button', 'Shell button', 'Metal shank button', 'Resin button']],
  ['LABEL', 'PIECES', ['Woven label', 'Care label', 'Size label']],
  ['ZIPPER', 'PIECES', ['Nylon zipper', 'Metal zipper', 'Invisible zipper']],
  ['PACKAGING', 'PIECES', ['Poly bag', 'Carton', 'Tissue paper']],
  ['ACCESSORY', 'PIECES', ['Elastic', 'Drawcord', 'Eyelet', 'Hook & eye']],
];
const COLORS = [['Navy', '#1F2A44'], ['Black', '#111111'], ['White', '#FAFAFA'], ['Olive', '#556B2F'], ['Maroon', '#800000'], ['Sky', '#87CEEB'], ['Beige', '#D9C7A7'], ['Rust', '#B7410E']];
const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const DESIGN_CATS = ['SHIRT', 'T_SHIRT', 'DRESS', 'TROUSER', 'KURTA', 'JACKET', 'SKIRT', 'SHORTS'];
const DESIGN_STATUSES = ['DRAFT', 'DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'APPROVED', 'RELEASED', 'RELEASED', 'REJECTED', 'REVISION_REQUESTED'];
const STAGES = ['CUTTING', 'STITCHING', 'FINISHING', 'PACKING'];

/** Assumes mongoose is already connected to a LOCAL database (see CLI below / dev-memory.js). */
export async function seedLarge({ log = console.log } = {}) {
  const t0 = Date.now();
  const factory = await Factory.findOne({ isDeleted: { $ne: true } }).sort({ createdAt: 1 }).lean();
  if (!factory) throw new Error('No factory found — run the demo seed first.');
  const factoryId = factory._id;
  const organizationId = factory.organizationId;
  const tenant = { organizationId, factoryId };
  const users = await User.find({ organizationId }).select('_id email').lean();
  if (!users.length) throw new Error('No users found for the demo organization.');
  const admin = users.find((u) => u.email === 'admin@demo.local') || users[0];
  const by = { createdBy: admin._id, updatedBy: admin._id };
  const stamp = (d) => ({ createdAt: d, updatedAt: d, isDeleted: false });
  const counts = {};

  // Suppliers
  const suppliers = Array.from({ length: 200 }, (_, i) => ({
    _id: oid(), ...tenant, ...by, ...stamp(daysAgo(int(30, 400))),
    supplierCode: `LV-${pad(i + 1, 4)}`,
    name: `${pick(['Shree', 'Om', 'Global', 'Prime', 'Sunrise', 'Royal', 'Metro'])} ${pick(['Textiles', 'Trims', 'Fabrics', 'Mills', 'Exports', 'Industries'])} ${i + 1}`,
    contactPerson: `Contact ${i + 1}`,
    contactEmail: `vendor${i + 1}@example.test`,
    phone: `98${pad(int(0, 99_999_999), 8)}`,
    leadTimeDays: int(3, 30),
    paymentTerms: pick(['Net 30', 'Net 45', 'Advance', 'Net 15']),
    status: rand() < 0.9 ? 'ACTIVE' : 'INACTIVE',
  }));
  counts.suppliers = await insertChunks(Supplier, suppliers);

  // Materials
  const materials = Array.from({ length: 2000 }, (_, i) => {
    const [category, unit, names] = pick(MAT_CATS);
    const [color] = pick(COLORS);
    return {
      _id: oid(), ...tenant, ...by, ...stamp(daysAgo(int(30, 500))),
      materialCode: `LM-${pad(i + 1)}`,
      name: `${pick(names)} ${color} ${i + 1}`,
      category,
      unit,
      unitCost: Math.round((category === 'FABRIC' ? int(80, 600) : int(1, 60)) * 100) / 100,
      reorderLevel: int(10, 500),
      supplierId: pick(suppliers)._id,
      images: [],
    };
  });
  counts.materials = await insertChunks(Material, materials);
  const fabrics = materials.filter((m) => m.category === 'FABRIC');
  const trims = materials.filter((m) => m.category !== 'FABRIC');

  // Designs
  const designs = Array.from({ length: 3000 }, (_, i) => {
    const category = pick(DESIGN_CATS);
    const status = pick(DESIGN_STATUSES);
    const created = daysAgo(int(1, 600));
    const colorVariants = Array.from({ length: int(1, 3) }, () => {
      const [name, hexCode] = pick(COLORS);
      return { name, hexCode, status: 'APPROVED', sizes: SIZES.map((size) => ({ size })) };
    });
    const fab = pick(fabrics);
    return {
      _id: oid(), ...tenant, ...by, ...stamp(created),
      designCode: `LD-${pad(i + 1)}`,
      styleNumber: `LS${pad(i + 1)}`,
      title: `${pick(['Classic', 'Relaxed', 'Slim', 'Boxy', 'Tailored', 'Summer', 'Festive'])} ${category.replace('_', ' ').toLowerCase()} ${i + 1}`,
      description: 'Performance dataset design.',
      category,
      subCategory: category,
      gender: pick(['MEN', 'WOMEN', 'UNISEX', 'KIDS']),
      tags: [category.toLowerCase(), pick(['ss26', 'aw26', 'core'])],
      targetPrice: int(399, 3999),
      currency: 'INR',
      colorVariants,
      fabricConsumption: [{ materialId: fab._id, consumption: Math.round(rand() * 250) / 100 + 0.5, unit: 'METERS', fabricCost: fab.unitCost }],
      accessories: [],
      bomLines: [],
      costing: { fabricCost: fab.unitCost, laborCost: int(40, 200) },
      productionInfo: { productionPriority: pick(['LOW', 'NORMAL', 'HIGH']) },
      currentVersion: 1,
      status,
      submittedAt: status === 'DRAFT' ? undefined : created,
      approvedAt: ['APPROVED', 'RELEASED'].includes(status) ? created : undefined,
      releasedAt: status === 'RELEASED' ? created : undefined,
    };
  });
  counts.designs = await insertChunks(Design, designs);

  // SKUs (5k) — on released/approved designs first
  const skuDesigns = designs.filter((d) => ['APPROVED', 'RELEASED'].includes(d.status));
  const skus = [];
  for (let i = 0; skus.length < 5000; i += 1) {
    const d = skuDesigns[i % skuDesigns.length];
    const [colorName, hexCode] = pick(COLORS);
    const size = SIZES[i % SIZES.length];
    skus.push({
      _id: oid(), ...tenant, ...by, ...stamp(daysAgo(int(1, 300))),
      skuCode: `LSKU-${pad(skus.length + 1, 6)}-${size}`,
      name: `${d.title} ${colorName} ${size}`,
      designId: d._id,
      size,
      color: { name: colorName, hexCode },
      barcode: `89${pad(skus.length + 1, 11)}`,
      basePrice: d.targetPrice,
      currency: 'INR',
      status: pick(['ACTIVE', 'ACTIVE', 'ACTIVE', 'DRAFT', 'DISCONTINUED']),
    });
  }
  counts.skus = await insertChunks(Sku, skus);

  // BOMs (600) — production orders need one
  const boms = skus.slice(0, 600).map((sku, i) => {
    const lines = [pick(fabrics), pick(trims), pick(trims), pick(trims)].map((m, li) => {
      const quantityPerPiece = li === 0 ? Math.round((0.8 + rand() * 1.8) * 100) / 100 : int(1, 6);
      const wastagePercent = li === 0 ? 5 : 2;
      const effectiveQuantity = quantityPerPiece * (1 + wastagePercent / 100);
      return {
        materialId: m._id, materialCategory: m.category, quantityPerPiece, unit: m.unit, wastagePercent,
        effectiveQuantity, unitCost: m.unitCost, extendedCost: effectiveQuantity * m.unitCost,
      };
    });
    return {
      _id: oid(), ...tenant, ...by, ...stamp(daysAgo(int(1, 200))),
      bomCode: `LBOM-${pad(i + 1)}`,
      skuId: sku._id,
      version: 1,
      status: rand() < 0.8 ? 'ACTIVE' : pick(['DRAFT', 'APPROVED', 'PENDING_APPROVAL']),
      lines,
      totalCostPerPiece: lines.reduce((s, l) => s + l.extendedCost, 0),
    };
  });
  counts.boms = await insertChunks(Bom, boms);

  // Purchase: 1k PRs, 1k POs, 1k GRNs
  const prs = Array.from({ length: 1000 }, (_, i) => {
    const status = pick(['DRAFT', 'SUBMITTED', 'APPROVED', 'APPROVED', 'CONVERTED', 'CONVERTED', 'REJECTED', 'CANCELLED']);
    return {
      _id: oid(), ...tenant, ...by, ...stamp(daysAgo(int(1, 365))),
      prNumber: `LPR-${pad(i + 1)}`,
      sourceType: rand() < 0.4 ? 'MRP' : 'MANUAL',
      lines: Array.from({ length: int(1, 4) }, () => {
        const m = pick(materials);
        return { _id: oid(), materialId: m._id, requiredQty: int(10, 2000), unit: m.unit, estimatedUnitCost: m.unitCost };
      }),
      status,
      requestedBy: pick(users)._id,
    };
  });
  counts.purchaseRequisitions = await insertChunks(PurchaseRequisition, prs);

  const pos = Array.from({ length: 1000 }, (_, i) => {
    const status = pick(['DRAFT', 'APPROVED', 'SENT', 'SENT', 'PARTIAL', 'RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED']);
    const lines = Array.from({ length: int(1, 5) }, () => {
      const m = pick(materials);
      const orderedQty = int(20, 3000);
      const receivedQty = ['RECEIVED', 'CLOSED'].includes(status) ? orderedQty : status === 'PARTIAL' ? Math.floor(orderedQty / 2) : 0;
      return {
        _id: oid(), materialId: m._id, orderedQty, receivedQty, acceptedQty: receivedQty, rejectedQty: 0,
        unit: m.unit, unitPrice: m.unitCost, extendedPrice: orderedQty * m.unitCost,
      };
    });
    const created = daysAgo(int(1, 365));
    return {
      _id: oid(), ...tenant, ...by, ...stamp(created),
      poNumber: `LPO-${pad(i + 1)}`,
      supplierId: pick(suppliers)._id,
      prId: prs[i]?.status === 'CONVERTED' ? prs[i]._id : undefined,
      lines,
      totalAmount: lines.reduce((s, l) => s + l.extendedPrice, 0),
      status,
      expectedDeliveryDate: new Date(created.getTime() + int(5, 40) * 86_400_000),
      paymentStatus: rand() < 0.4 ? 'PAID' : 'UNPAID',
      receipts: [],
      __v: 0,
    };
  });
  counts.purchaseOrders = await insertChunks(PurchaseOrder, pos);

  const receivable = pos.filter((p) => ['PARTIAL', 'RECEIVED', 'CLOSED', 'SENT'].includes(p.status));
  const grns = Array.from({ length: 1000 }, (_, i) => {
    const po = receivable[i % receivable.length];
    const status = pick(['COMPLETED', 'COMPLETED', 'COMPLETED', 'PENDING_QC', 'DRAFT', 'CANCELLED']);
    return {
      _id: oid(), ...tenant, ...by, ...stamp(daysAgo(int(1, 300))),
      grnNumber: `LGRN-${pad(i + 1)}`,
      poId: po._id,
      lines: po.lines.map((l) => ({
        _id: oid(), materialId: l.materialId, poLineId: l._id, receivedQty: Math.max(1, Math.floor(l.orderedQty / 2)),
        acceptedQty: status === 'COMPLETED' ? Math.max(1, Math.floor(l.orderedQty / 2)) : 0, rejectedQty: 0,
        unit: l.unit, unitPrice: l.unitPrice,
      })),
      status,
      poSyncedAt: status === 'COMPLETED' ? new Date() : null,
      receivedBy: pick(users)._id,
      receipts: [],
    };
  });
  counts.goodsReceipts = await insertChunks(GoodsReceipt, grns);

  // Production: 2k orders + batches
  const orders = Array.from({ length: 2000 }, (_, i) => {
    const bom = pick(boms);
    const sku = skus.find((s) => s._id === bom.skuId);
    const status = pick(['CREATED', 'MRP_DONE', 'MATERIAL_RESERVED', 'APPROVAL_PENDING', 'APPROVED', 'IN_PROGRESS', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED', 'CANCELLED']);
    const plannedQuantity = int(50, 2000);
    const done = status === 'COMPLETED' ? plannedQuantity : status === 'IN_PROGRESS' ? Math.floor(plannedQuantity * rand()) : 0;
    const created = daysAgo(int(1, 365));
    return {
      _id: oid(), ...tenant, ...by, ...stamp(created),
      orderNumber: `LPRD-${pad(i + 1)}`,
      designId: sku.designId,
      skuId: sku._id,
      bomId: bom._id,
      plannedQuantity,
      producedQuantity: done,
      passedQuantity: Math.floor(done * 0.97),
      rejectedQuantity: done - Math.floor(done * 0.97),
      priority: pick(['LOW', 'NORMAL', 'NORMAL', 'HIGH', 'URGENT']),
      status,
      deliveryDate: new Date(created.getTime() + int(10, 90) * 86_400_000),
      plannedStart: created,
      plannedEnd: new Date(created.getTime() + int(5, 60) * 86_400_000),
      standardCostPerPiece: bom.totalCostPerPiece,
      standardMaterialCost: bom.totalCostPerPiece * plannedQuantity,
      actualMaterialCost: 0,
    };
  });
  counts.productionOrders = await insertChunks(ProductionOrder, orders);

  const batches = [];
  for (const o of orders) {
    if (['CREATED', 'MRP_DONE', 'CANCELLED'].includes(o.status)) continue;
    const n = int(1, 2);
    for (let b = 0; b < n; b += 1) {
      const status = o.status === 'COMPLETED' ? 'COMPLETED' : o.status === 'IN_PROGRESS' ? pick(['CREATED', 'IN_PROGRESS', 'IN_PROGRESS', 'COMPLETED']) : 'CREATED';
      const planned = Math.max(1, Math.floor(o.plannedQuantity / n));
      batches.push({
        _id: oid(), ...tenant, ...by, ...stamp(o.createdAt),
        batchNumber: `LB-${pad(batches.length + 1, 6)}`,
        productionOrderId: o._id,
        plannedQuantity: planned,
        producedQuantity: status === 'COMPLETED' ? planned : 0,
        passedQuantity: status === 'COMPLETED' ? planned : 0,
        stages: STAGES,
        currentStage: status === 'COMPLETED' ? 'PACKING' : pick(STAGES),
        status,
        stageHistory: [],
        workerIds: [],
        stageQcPassed: {},
        issuedMaterials: [],
      });
    }
  }
  counts.productionBatches = await insertChunks(ProductionBatch, batches);

  // Inventory: one RM balance per new material, FG balances for 3k SKUs, 8k transactions
  const rmBalances = materials.map((m) => {
    const onHand = int(0, 5000);
    const reserved = Math.min(onHand, int(0, 300));
    return {
      _id: oid(), ...tenant, ...by, ...stamp(daysAgo(int(0, 60))),
      inventoryType: 'RAW_MATERIAL', materialId: m._id, storageBinId: null, locationId: null,
      onHand, reserved, available: onHand - reserved, unit: m.unit, __v: 0,
    };
  });
  const fgBalances = skus.slice(0, 3000).map((s) => {
    const onHand = int(0, 800);
    return {
      _id: oid(), ...tenant, ...by, ...stamp(daysAgo(int(0, 60))),
      inventoryType: 'FINISHED_GOODS', skuId: s._id, storageBinId: null, locationId: null,
      onHand, reserved: 0, available: onHand, unit: 'PIECES', __v: 0,
    };
  });
  counts.inventoryBalances = await insertChunks(InventoryBalance, [...rmBalances, ...fgBalances]);

  const txTypes = ['RECEIPT', 'RECEIPT', 'ISSUE', 'ISSUE', 'ADJUSTMENT', 'TRANSFER', 'RESERVATION', 'RESERVATION_RELEASE'];
  const txs = Array.from({ length: 8000 }, () => {
    const type = pick(txTypes);
    const m = pick(materials);
    return {
      _id: oid(), ...tenant, ...by, ...stamp(daysAgo(int(0, 365))),
      type, materialId: m._id, quantity: int(1, 500), unit: m.unit,
      direction: type === 'ADJUSTMENT' ? pick(['IN', 'OUT']) : undefined,
      referenceType: type === 'RECEIPT' ? 'GOODS_RECEIPT' : type === 'ISSUE' ? 'PRODUCTION_BATCH' : 'MANUAL',
      referenceId: type === 'RECEIPT' ? pick(grns)._id : type === 'ISSUE' ? pick(batches)?._id : undefined,
      unitCost: type === 'RECEIPT' ? m.unitCost : undefined,
      note: 'perf dataset',
      performedBy: pick(users)._id,
      storageBinId: null,
    };
  });
  counts.inventoryTransactions = await insertChunks(InventoryTransaction, txs);

  // Notifications: 5k spread across users (admin gets the most)
  const events = [
    ['purchase.requisition.submitted', 'Purchase requisition submitted', 'PURCHASE_REQUISITION', prs],
    ['production.order.created', 'Production order created', 'PRODUCTION_ORDER', orders],
    ['design.submitted', 'Design submitted for review', 'DESIGN', designs],
    ['grn.created', 'Goods received', 'GOODS_RECEIPT', grns],
  ];
  const notifications = Array.from({ length: 5000 }, (_, i) => {
    const [eventType, title, referenceType, docs] = pick(events);
    const read = rand() < 0.7;
    const created = daysAgo(int(0, 120));
    return {
      _id: oid(), ...tenant, ...stamp(created),
      userId: i % 2 === 0 ? admin._id : pick(users)._id,
      eventType, title, message: `${title} (perf dataset #${i + 1})`, channel: 'IN_APP',
      status: read ? 'READ' : 'UNREAD', readAt: read ? created : undefined,
      referenceType, referenceId: pick(docs)._id,
    };
  });
  counts.notifications = await insertChunks(Notification, notifications);

  // Approval instances: 3k (≈20 % pending)
  const docSets = [['PURCHASE_REQUISITION', prs], ['PRODUCTION_ORDER', orders], ['DESIGN', designs], ['BOM', boms]];
  const approvals = Array.from({ length: 3000 }, () => {
    const [documentType, docs] = pick(docSets);
    const status = rand() < 0.2 ? 'PENDING' : pick(['APPROVED', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'CANCELLED']);
    const submittedAt = daysAgo(int(0, 200));
    return {
      _id: oid(), ...tenant,
      documentType, documentId: pick(docs)._id, status, currentLevel: 1,
      submittedBy: pick(users)._id, submittedAt,
      steps: status === 'PENDING' ? [] : [{ level: 1, approverId: admin._id, action: status, comments: '', actionAt: submittedAt }],
      completedAt: status === 'PENDING' ? undefined : submittedAt,
    };
  });
  counts.approvalInstances = await insertChunks(ApprovalInstance, approvals);

  // Audit logs: 5k
  const auditMods = [['purchase', 'PurchaseOrder', pos], ['production', 'ProductionOrder', orders], ['design', 'Design', designs], ['inventory', 'Material', materials]];
  const audits = Array.from({ length: 5000 }, () => {
    const [module, documentType, docs] = pick(auditMods);
    const u = pick(users);
    return {
      _id: oid(), ...tenant, userId: u._id, userEmail: u.email, module,
      action: pick(['CREATE', 'UPDATE', 'UPDATE', 'APPROVE', 'DELETE']),
      documentType, documentId: pick(docs)._id,
      updatedData: { note: 'perf dataset' },
      timestamp: daysAgo(int(0, 365)),
    };
  });
  counts.auditLogs = await insertChunks(AuditLog, audits);

  log(`[seed-large] inserted in ${Date.now() - t0}ms: ${JSON.stringify(counts)}`);
  return counts;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/scripts/seed-large.js');
if (isMain) {
  const arg = process.argv.find((a) => a.startsWith('--uri='));
  const uri = arg ? arg.slice('--uri='.length) : process.env.SEED_LARGE_URI;
  if (!uri) {
    console.error('Refusing to run: pass --uri=mongodb://127.0.0.1:<port>/<db> (or SEED_LARGE_URI). .env is never used.');
    process.exit(1);
  }
  if (!isLocalMongoUri(uri)) {
    console.error(`Refusing to run against a non-local database: ${uri.replace(/\/\/[^@]*@/, '//***@')}`);
    console.error('seed-large only runs against localhost / 127.0.0.1 / ::1 (e.g. the in-memory dev server).');
    process.exit(1);
  }
  mongoose.connect(uri)
    .then(() => seedLarge())
    .then(() => mongoose.disconnect())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
