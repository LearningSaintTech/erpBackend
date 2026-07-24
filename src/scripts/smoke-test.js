import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import app from '../app.js';
import { Permission } from '../modules/user/permission.model.js';
import { Role } from '../modules/user/role.model.js';
import { User } from '../modules/user/user.model.js';
import { Organization } from '../modules/organization/organization.model.js';
import { UserRoleAssignment } from '../modules/user/userRoleAssignment.model.js';
import { createFactory } from '../modules/organization/organization.service.js';
import { getFactoryAdminPermissions } from '../config/systemRoles.js';

const ALL_PERMS = getFactoryAdminPermissions();

async function api(base, path, { method = 'GET', token, factoryId, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (factoryId) headers['X-Factory-Id'] = factoryId;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { res, data };
}

function assertApi(label, { data }) {
  if (!data?.success) {
    const msg = data?.error?.message || data?.message || JSON.stringify(data);
    throw new Error(`${label}: ${msg}`);
  }
  return data.data;
}

const QC_GATED_STAGES = new Set(['CUTTING', 'STITCHING', 'FINISHING', 'PACKING', 'SEWING']);

async function advanceBatchToCompletion(base, batchId, opts) {
  let batch = assertApi('Get batch', await api(base, `/api/v1/batches/${batchId}`, opts));
  let guard = 0;
  while (batch.status === 'IN_PROGRESS' && batch.currentStage !== 'COMPLETED' && guard < 20) {
    guard += 1;
    if (QC_GATED_STAGES.has(batch.currentStage)) {
      const inQc = assertApi('In-process QC', await api(base, `/api/v1/batches/${batchId}/in-process-qc`, { method: 'POST', ...opts }));
      assertApi('Complete in-process QC', await api(base, `/api/v1/quality-inspections/${inQc._id}/complete`, {
        method: 'POST', ...opts,
        body: { passedQuantity: batch.plannedQuantity, failedQuantity: 0, result: 'PASS' },
      }));
    }
    batch = assertApi('Complete stage', await api(base, `/api/v1/batches/${batchId}/complete-stage`, { method: 'POST', ...opts }));
  }
  if (batch.status !== 'COMPLETED') {
    throw new Error(`Batch did not complete (status=${batch.status}, stage=${batch.currentStage})`);
  }
  return batch;
}

async function smokeTest() {
  const mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());

  for (const code of ALL_PERMS) {
    const [module, action] = code.split('.');
    await Permission.create({ code, module, action, description: code });
  }

  const superAdmin = await User.create({
    email: 'superadmin@erp.local',
    passwordHash: await User.hashPassword('SuperAdmin@123'),
    firstName: 'Super',
    lastName: 'Admin',
    isSuperAdmin: true,
    status: 'ACTIVE',
  });

  const org = await Organization.create({
    code: 'TEST',
    name: 'Test Org',
    status: 'ACTIVE',
    createdBy: superAdmin._id,
  });

  const factoryRole = await Role.create({
    organizationId: org._id,
    code: 'FACTORY_ADMIN',
    name: 'Factory Admin',
    permissions: ALL_PERMS,
    isSystem: true,
  });

  const factory = await createFactory(org._id, { code: 'F01', name: 'Test Factory' }, superAdmin._id);

  const admin = await User.create({
    organizationId: org._id,
    email: 'admin@demo.com',
    passwordHash: await User.hashPassword('Test@12345'),
    firstName: 'Test',
    lastName: 'Admin',
    status: 'ACTIVE',
  });

  await UserRoleAssignment.create({
    organizationId: org._id,
    userId: admin._id,
    roleId: factoryRole._id,
    factoryId: factory._id,
    assignedBy: superAdmin._id,
  });

  const worker = await User.create({
    organizationId: org._id,
    email: 'worker@demo.com',
    passwordHash: await User.hashPassword('Test@12345'),
    firstName: 'Line',
    lastName: 'Worker',
    status: 'ACTIVE',
  });

  await UserRoleAssignment.create({
    organizationId: org._id,
    userId: worker._id,
    roleId: factoryRole._id,
    factoryId: factory._id,
    assignedBy: superAdmin._id,
  });

  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const { res: health } = await api(base, '/health');
    if (!health.ok) throw new Error('Health check failed');

    const loginPayload = await api(base, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'admin@demo.com', password: 'Test@12345' },
    });
    const login = assertApi('Login', loginPayload);
    const token = login.accessToken;
    const factoryId = login.factories[0]._id;
    const adminUserId = login.user._id;
    const opts = { token, factoryId };

    // Chat module
    assertApi('Chat catalog', await api(base, '/api/v1/chat/catalog', opts));

    const group = assertApi('Create chat group', await api(base, '/api/v1/chat/rooms/group', {
      method: 'POST', ...opts,
      body: { name: 'Production Team', memberIds: [worker._id.toString()] },
    }));

    assertApi('Send chat message', await api(base, `/api/v1/chat/rooms/${group._id}/messages`, {
      method: 'POST', ...opts,
      body: { body: 'Hello production team' },
    }));

    const adminRooms = assertApi('Admin list chat rooms', await api(base, '/api/v1/chat/admin/rooms', opts));
    if (!adminRooms.length) throw new Error('Admin chat rooms list empty');

    const direct = assertApi('Create direct chat', await api(base, '/api/v1/chat/rooms/direct', {
      method: 'POST', ...opts,
      body: { userId: worker._id.toString() },
    }));
    if (direct.type !== 'DIRECT') throw new Error('Direct chat room type mismatch');

    console.log('Smoke test passed: Chat module (group, message, admin list, direct)');

    // Materials + stock
    const mat1 = assertApi('Create material', await api(base, '/api/v1/materials', {
      method: 'POST', ...opts,
      body: { materialCode: 'FAB-COT-001', name: 'Cotton Fabric', unit: 'METERS', unitCost: 120, category: 'FABRIC' },
    }));
    const fabricId = mat1._id;

    const mat2 = assertApi('Create button material', await api(base, '/api/v1/materials', {
      method: 'POST', ...opts,
      body: { materialCode: 'BTN-001', name: 'Buttons', unit: 'PIECES', unitCost: 2, category: 'ACCESSORY' },
    }));
    const buttonId = mat2._id;

    await api(base, '/api/v1/inventory/receipt', {
      method: 'POST', ...opts,
      body: { materialId: fabricId, quantity: 100, unit: 'METERS' },
    });
    await api(base, '/api/v1/inventory/receipt', {
      method: 'POST', ...opts,
      body: { materialId: buttonId, quantity: 500, unit: 'PIECES' },
    });

    // Collection → Design → submit → approve → release
    const collection = assertApi('Create collection', await api(base, '/api/v1/collections', {
      method: 'POST', ...opts,
      body: { name: 'Smoke SS26', description: 'Smoke test collection' },
    }));
    const collectionId = collection._id;

    const design = assertApi('Create design', await api(base, '/api/v1/designs', {
      method: 'POST', ...opts,
      body: {
        title: 'Summer Shirt',
        collectionId,
        fabricConsumption: [{
          materialId: fabricId,
          consumption: 2.5,
          unit: 'METERS',
          wastagePercent: 5,
          fabricCost: 120,
        }],
        accessories: [{
          accessoryType: 'BUTTON',
          materialId: buttonId,
          consumption: 6,
          unit: 'PIECES',
        }],
        colorVariants: [{ name: 'Navy', code: 'NVY' }],
      },
    }));
    const designId = design._id;

    assertApi('Design asset upload', await api(base, `/api/v1/designs/${designId}/assets`, {
      method: 'POST', ...opts,
      body: {
        fileName: 'smoke-test.png',
        mimeType: 'image/png',
        contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        assetType: 'FRONT_IMAGE',
      },
    }));

    assertApi('Design submit', await api(base, `/api/v1/designs/${designId}/submit`, { method: 'POST', ...opts }));
    const approvedDesign = assertApi('Design approve', await api(base, `/api/v1/designs/${designId}/approve`, { method: 'POST', ...opts }));
    if (approvedDesign.status !== 'APPROVED') throw new Error('Design approve failed');

    const releasedDesign = assertApi('Design release', await api(base, `/api/v1/designs/${designId}/release`, { method: 'POST', ...opts }));
    if (releasedDesign.status !== 'RELEASED') throw new Error('Design release failed');

    // Pattern development
    assertApi('Pattern assign', await api(base, '/api/v1/pattern-developments/assign', {
      method: 'POST', ...opts,
      body: { designId, patternMasterId: adminUserId },
    }));
    assertApi('Pattern verify', await api(base, `/api/v1/pattern-developments/${designId}`, {
      method: 'PUT', ...opts,
      body: { sizeChartVerified: true, consumptionVerified: true, sampleBomVerified: true },
    }));
    const patternDone = assertApi('Pattern complete', await api(base, `/api/v1/pattern-developments/${designId}/complete`, { method: 'POST', ...opts }));
    if (patternDone.status !== 'COMPLETED') throw new Error('Pattern complete failed');

    // Sample → material request → reserve → issue → complete → QC → approve
    const sample = assertApi('Create sample', await api(base, '/api/v1/samples', {
      method: 'POST', ...opts,
      body: { designId, laborHours: 4, laborRate: 150 },
    }));
    const sampleId = sample._id;

    const pendingMr = assertApi('Submit material request', await api(base, `/api/v1/samples/${sampleId}/submit-material-request`, { method: 'POST', ...opts }));
    if (pendingMr.status !== 'MATERIAL_REQUEST_PENDING') throw new Error('Submit material request failed');

    const approvedMr = assertApi('Approve material request', await api(base, `/api/v1/samples/${sampleId}/approve-material-request`, { method: 'POST', ...opts }));
    if (approvedMr.status !== 'MATERIAL_REQUEST_APPROVED') throw new Error('Approve material request failed');

    const reserved = assertApi('Reserve materials', await api(base, `/api/v1/samples/${sampleId}/reserve-materials`, { method: 'POST', ...opts }));
    if (reserved.status !== 'MATERIAL_RESERVED') throw new Error('Reserve materials failed');

    const issued = assertApi('Issue materials', await api(base, `/api/v1/samples/${sampleId}/issue-materials`, { method: 'POST', ...opts }));
    if (issued.status !== 'IN_PROGRESS') throw new Error('Issue materials failed');

    assertApi('Complete sample', await api(base, `/api/v1/samples/${sampleId}/complete`, { method: 'POST', ...opts }));
    const qcPassed = assertApi('Sample QC pass', await api(base, `/api/v1/samples/${sampleId}/qc-pass`, {
      method: 'POST', ...opts,
      body: { comments: 'Smoke test QC pass' },
    }));
    if (qcPassed.status !== 'PENDING_APPROVAL') throw new Error('Sample QC pass failed');

    const approvedSample = assertApi('Approve sample', await api(base, `/api/v1/samples/${sampleId}/approve`, { method: 'POST', ...opts }));
    if (approvedSample.status !== 'APPROVED') throw new Error('Sample approve failed');

    // SKU
    const sku = assertApi('Create SKU', await api(base, '/api/v1/skus', {
      method: 'POST', ...opts,
      body: { sampleId, size: 'M', basePrice: 899 },
    }));
    const skuId = sku._id;

    // BOM → approve → finalize (MRP)
    const { data: bomData } = await api(base, '/api/v1/boms', {
      method: 'POST', ...opts,
      body: {
        skuId,
        lines: [
          { materialId: fabricId, quantityPerPiece: 2.5, unit: 'METERS', wastagePercent: 5, unitCost: 120 },
          { materialId: buttonId, quantityPerPiece: 6, unit: 'PIECES', unitCost: 2 },
        ],
      },
    });
    if (!bomData.success) throw new Error('Create BOM failed');
    const bomId = bomData.data._id;

    await api(base, `/api/v1/boms/${bomId}/approve`, { method: 'POST', ...opts });
    const { data: finalized } = await api(base, `/api/v1/boms/${bomId}/finalize`, { method: 'POST', ...opts });
    if (finalized.data.bom?.status !== 'ACTIVE') throw new Error('BOM finalize failed');
    if (!finalized.data.mrp) throw new Error('MRP preview missing');

    const { data: mrpPreview } = await api(base, `/api/v1/boms/${bomId}/mrp-preview`, opts);
    if (!mrpPreview.success) throw new Error('MRP preview fetch failed');

    // Phase 3: warehouse, purchase, production, QC
    await api(base, '/api/v1/warehouses', {
      method: 'POST', ...opts,
      body: { warehouseCode: 'WH-RM', name: 'Raw Material Store', type: 'RAW_MATERIAL', isDefault: true },
    });
    await api(base, '/api/v1/warehouses', {
      method: 'POST', ...opts,
      body: { warehouseCode: 'WH-FG', name: 'Finished Goods', type: 'FINISHED_GOODS', isDefault: true },
    });

    const { data: supplierData } = await api(base, '/api/v1/suppliers', {
      method: 'POST', ...opts,
      body: { supplierCode: 'SUP-01', name: 'Textile Supplies Co', leadTimeDays: 5 },
    });
    if (!supplierData.success) throw new Error('Create supplier failed');
    const supplierId = supplierData.data._id;

    const { data: prData } = await api(base, '/api/v1/purchase-requisitions', {
      method: 'POST', ...opts,
      body: {
        lines: [{ materialId: fabricId, requiredQty: 50, unit: 'METERS', estimatedUnitCost: 120 }],
      },
    });
    if (!prData.success) throw new Error('Create PR failed');
    const prId = prData.data._id;
    await api(base, `/api/v1/purchase-requisitions/${prId}/submit`, { method: 'POST', ...opts });
    await api(base, `/api/v1/purchase-requisitions/${prId}/approve`, { method: 'POST', ...opts });

    const { data: poData } = await api(base, '/api/v1/purchase-orders', {
      method: 'POST', ...opts,
      body: { supplierId, prId },
    });
    if (!poData.success) throw new Error('Create PO failed');
    const poId = poData.data._id;
    await api(base, `/api/v1/purchase-orders/${poId}/approve`, { method: 'POST', ...opts });
    await api(base, `/api/v1/purchase-orders/${poId}/send`, { method: 'POST', ...opts });

    const { data: grnData } = await api(base, '/api/v1/goods-receipts', {
      method: 'POST', ...opts,
      body: { poId, lines: [{ materialId: fabricId, receivedQty: 50, unit: 'METERS' }] },
    });
    if (!grnData.success) throw new Error('Create GRN failed');
    const grnId = grnData.data._id;
    await api(base, `/api/v1/goods-receipts/${grnId}/submit-qc`, { method: 'POST', ...opts });
    const { data: inQc } = await api(base, `/api/v1/goods-receipts/${grnId}/qc`, { method: 'POST', ...opts });
    if (!inQc.success) throw new Error('Incoming QC create failed');
    await api(base, `/api/v1/quality-inspections/${inQc.data._id}/complete`, {
      method: 'POST', ...opts,
      body: { passedQuantity: 50, failedQuantity: 0, result: 'PASS' },
    });

    const { data: prodData } = await api(base, '/api/v1/production-orders', {
      method: 'POST', ...opts,
      body: { skuId, plannedQuantity: 5 },
    });
    if (!prodData.success) throw new Error('Create production order failed');
    const prodId = prodData.data._id;
    await api(base, `/api/v1/production-orders/${prodId}/mrp`, { method: 'POST', ...opts });
    await api(base, `/api/v1/production-orders/${prodId}/reserve`, { method: 'POST', ...opts });
    assertApi('Submit production for approval', await api(base, `/api/v1/production-orders/${prodId}/submit-approval`, { method: 'POST', ...opts }));
    const approvedProd = assertApi('Approve production order', await api(base, `/api/v1/production-orders/${prodId}/approve`, { method: 'POST', ...opts }));
    if (approvedProd.status !== 'APPROVED') throw new Error('Production approve failed');

    const { data: batchData } = await api(base, `/api/v1/production-orders/${prodId}/batches`, {
      method: 'POST', ...opts,
      body: { plannedQuantity: 5 },
    });
    if (!batchData.success) throw new Error('Create batch failed');
    const batchId = batchData.data._id;
    await api(base, `/api/v1/batches/${batchId}/start`, { method: 'POST', ...opts });
    await advanceBatchToCompletion(base, batchId, opts);

    const { data: finalQc } = await api(base, `/api/v1/batches/${batchId}/qc`, { method: 'POST', ...opts });
    if (!finalQc.success) throw new Error('Final QC create failed');
    await api(base, `/api/v1/quality-inspections/${finalQc.data._id}/complete`, {
      method: 'POST', ...opts,
      body: { passedQuantity: 5, failedQuantity: 0, result: 'PASS' },
    });

    console.log('Smoke test passed: design → pattern → sample → BOM → purchase → production → QC → FG');

    // Phase 4: reports & notifications
    const { data: factoryDash } = await api(base, '/api/v1/reports/factory', opts);
    if (!factoryDash.success || !factoryDash.data.summary) throw new Error('Factory dashboard failed');

    const { data: prodDash } = await api(base, '/api/v1/reports/production', opts);
    if (!prodDash.success) throw new Error('Production dashboard failed');

    const { data: notifCount } = await api(base, '/api/v1/notifications/unread-count', opts);
    if (!notifCount.success) throw new Error('Notification unread count failed');

    const { data: notifs } = await api(base, '/api/v1/notifications', opts);
    if (!notifs.success) throw new Error('Notifications list failed');

    const exportRes = await fetch(`${base}/api/v1/reports/factory/export`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Factory-Id': factoryId },
    });
    if (!exportRes.ok) throw new Error('Report export failed');

    const { data: pending } = await api(base, '/api/v1/approvals/pending', opts);
    if (!pending.success) throw new Error('Approvals pending failed');

    console.log('Smoke test passed: Phase 1–4 (full ERP + reports + notifications)');

    // Phase 5: waste, RFQ, warehouse ops
    const { data: wasteData } = await api(base, '/api/v1/waste-records', {
      method: 'POST', ...opts,
      body: {
        wasteType: 'FABRIC_SCRAP',
        batchId,
        materialId: fabricId,
        quantity: 1.5,
        unit: 'METERS',
        unitCost: 120,
        reasonCode: 'CUTTING',
      },
    });
    if (!wasteData.success) throw new Error('Create waste record failed');

    const { data: wasteSummary } = await api(base, '/api/v1/waste-records/summary', opts);
    if (!wasteSummary.success || wasteSummary.data.count < 1) throw new Error('Waste summary failed');

    const { data: whList } = await api(base, '/api/v1/warehouses', opts);
    const rmWarehouse = whList.data.find((w) => w.type === 'RAW_MATERIAL');
    if (!rmWarehouse) throw new Error('RM warehouse missing');

    const { data: binData } = await api(base, `/api/v1/warehouses/${rmWarehouse._id}/bins`, {
      method: 'POST', ...opts,
      body: { zoneCode: 'A', binCode: 'A-01' },
    });
    if (!binData.success) throw new Error('Create storage bin failed');
    const binId = binData.data._id;

    const { data: putAwayData } = await api(base, '/api/v1/warehouse-operations/put-away', {
      method: 'POST', ...opts,
      body: { materialId: fabricId, binId },
    });
    if (!putAwayData.success) throw new Error('Put-away failed');

    const { data: pr2Data } = await api(base, '/api/v1/purchase-requisitions', {
      method: 'POST', ...opts,
      body: {
        lines: [{ materialId: buttonId, requiredQty: 100, unit: 'PIECES', estimatedUnitCost: 2 }],
      },
    });
    if (!pr2Data.success) throw new Error('Create PR2 failed');
    const pr2Id = pr2Data.data._id;
    await api(base, `/api/v1/purchase-requisitions/${pr2Id}/submit`, { method: 'POST', ...opts });
    await api(base, `/api/v1/purchase-requisitions/${pr2Id}/approve`, { method: 'POST', ...opts });

    const { data: rfqData } = await api(base, '/api/v1/rfqs/from-pr', {
      method: 'POST', ...opts,
      body: { prId: pr2Id, supplierIds: [supplierId] },
    });
    if (!rfqData.success) throw new Error('Create RFQ failed');
    const rfqId = rfqData.data._id;
    await api(base, `/api/v1/rfqs/${rfqId}/send`, { method: 'POST', ...opts });

    const { data: quoteData } = await api(base, `/api/v1/rfqs/${rfqId}/quotations`, {
      method: 'POST', ...opts,
      body: {
        supplierId,
        lines: [{ materialId: buttonId, quantity: 100, unit: 'PIECES', unitPrice: 1.8 }],
      },
    });
    if (!quoteData.success) throw new Error('Add quotation failed');
    const quoteId = quoteData.data._id;

    const { data: compareData } = await api(base, `/api/v1/rfqs/${rfqId}/quotations/compare`, opts);
    if (!compareData.success || !compareData.data.length) throw new Error('Compare quotations failed');

    const { data: selectData } = await api(base, `/api/v1/quotations/${quoteId}/select`, { method: 'POST', ...opts });
    if (!selectData.success || !selectData.data.purchaseOrder) throw new Error('Select quotation failed');

    const { data: wasteReport } = await api(base, '/api/v1/reports/waste', opts);
    if (!wasteReport.success) throw new Error('Waste report failed');

    console.log('Smoke test passed: Phase 1–5 (waste + RFQ + warehouse ops + email log)');

    // Gap plan: hardening + extended modules
    const { data: factorySettings } = await api(base, `/api/v1/factories/${factoryId}/settings`, opts);
    if (!factorySettings.success) throw new Error('Factory settings get failed');

    const { data: machineData } = await api(base, '/api/v1/machines', {
      method: 'POST', ...opts,
      body: { machineCode: 'MC-01', name: 'Cutting Table 1', machineType: 'CUTTING', capacityPerHour: 50 },
    });
    if (!machineData.success) throw new Error('Create machine failed');

    const { data: machineReport } = await api(base, '/api/v1/reports/machine', opts);
    if (!machineReport.success) throw new Error('Machine report failed');

    const { data: financialReport } = await api(base, '/api/v1/reports/financial', opts);
    if (!financialReport.success) throw new Error('Financial report failed');

    const { data: ready } = await api(base, '/api/v1/health/ready', {});
    if (!ready.success) throw new Error('Readiness check failed');

    const openApiRes = await fetch(`${base}/api/v1/docs/openapi.json`);
    if (!openApiRes.ok) throw new Error('OpenAPI spec failed');

    console.log('Smoke test passed: Gap plan modules (machines, settings, reports, platform)');
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
  }
}

smokeTest().catch((err) => {
  console.error('Smoke test failed:', err.message);
  process.exit(1);
});
