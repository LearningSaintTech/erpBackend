import { Organization } from './organization.model.js';
import { Factory } from './factory.model.js';
import { FactorySettings } from './factorySettings.model.js';
import { FinancialYear } from './financialYear.model.js';
import { NotFoundError, ConflictError } from '../../shared/errors/AppError.js';
import { applySoftDeleteFilter } from '../../shared/utils/schema.js';

export async function createOrganization(data, createdBy) {
  const exists = await Organization.findOne({ code: data.code.toUpperCase() });
  if (exists) throw new ConflictError('Organization code already exists');
  return Organization.create({ ...data, code: data.code.toUpperCase(), createdBy });
}

export async function listOrganizations({ page, limit, skip }) {
  const filter = applySoftDeleteFilter();
  const [items, total] = await Promise.all([
    Organization.find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }),
    Organization.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getOrganization(id) {
  const org = await Organization.findOne(applySoftDeleteFilter({ _id: id }));
  if (!org) throw new NotFoundError('Organization not found');
  return org;
}

export async function createFactory(organizationId, data, createdBy) {
  const code = data.code.toUpperCase();
  const exists = await Factory.findOne({ organizationId, code, isDeleted: false });
  if (exists) throw new ConflictError('Factory code already exists in organization');

  const settings = await FactorySettings.create({
    organizationId,
    factoryId: null,
    shifts: [{ name: 'General', startTime: '09:00', endTime: '18:00' }],
    workingDays: [1, 2, 3, 4, 5, 6],
    productionStages: ['CUTTING', 'PRINTING', 'EMBROIDERY', 'STITCHING', 'WASHING', 'IRONING', 'FINISHING'],
    numberingPrefixes: {
      design: 'DSN', sku: 'SKU', purchaseOrder: 'PO', productionOrder: 'PRD', batch: 'BAT', sample: 'SMP',
    },
  });

  const factory = await Factory.create({
    organizationId,
    code,
    name: data.name,
    address: data.address,
    contact: data.contact,
    capacity: data.capacity,
    settingsId: settings._id,
    createdBy,
  });

  settings.factoryId = factory._id;
  await settings.save();
  return factory;
}

export async function listFactories(organizationId, { page, limit, skip }) {
  const filter = applySoftDeleteFilter({ organizationId });
  const [items, total] = await Promise.all([
    Factory.find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }),
    Factory.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getFactory(id) {
  const factory = await Factory.findOne(applySoftDeleteFilter({ _id: id }));
  if (!factory) throw new NotFoundError('Factory not found');
  return factory;
}

export async function createFinancialYear(organizationId, data) {
  if (data.isActive) {
    await FinancialYear.updateMany({ organizationId }, { isActive: false });
  }
  return FinancialYear.create({ organizationId, ...data });
}

export async function listFinancialYears(organizationId) {
  return FinancialYear.find({ organizationId, isDeleted: false }).sort({ startDate: -1 });
}

export async function getFactorySettings(factoryId) {
  const settings = await FactorySettings.findOne({ factoryId });
  if (!settings) throw new NotFoundError('Factory settings not found');
  return settings;
}

export async function updateFactorySettings(factoryId, data, userId) {
  const settings = await getFactorySettings(factoryId);
  if (data.shifts) settings.shifts = data.shifts;
  if (data.workingDays) settings.workingDays = data.workingDays;
  if (data.productionStages) settings.productionStages = data.productionStages;
  if (data.defaultWarehouses) settings.defaultWarehouses = data.defaultWarehouses;
  if (data.numberingPrefixes) settings.numberingPrefixes = data.numberingPrefixes;
  settings.updatedBy = userId;
  settings.updatedAt = new Date();
  await settings.save();
  return settings;
}
