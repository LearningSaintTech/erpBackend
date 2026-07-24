import Joi from 'joi';
import * as reportService from './report.service.js';
import { success, paginate, buildMeta } from '../../shared/utils/response.js';
import { REPORT_TYPES, DATE_PRESETS, EXPORT_FORMATS, REPORT_TYPE_LABELS } from './report.defaults.js';

export const dateFilterSchema = Joi.object({
  query: Joi.object({
    preset: Joi.string().valid(...DATE_PRESETS),
    from: Joi.date().iso(),
    to: Joi.date().iso(),
  }),
});

const dashboardHandlers = {
  factory: reportService.getFactoryDashboard,
  production: reportService.getProductionDashboard,
  inventory: reportService.getInventoryDashboard,
  purchase: reportService.getPurchaseDashboard,
  quality: reportService.getQualityDashboard,
  waste: reportService.getWasteDashboard,
  machine: reportService.getMachineDashboard,
  employee: reportService.getEmployeeDashboard,
  financial: reportService.getFinancialDashboard,
  approval: reportService.getApprovalDashboard,
};

function parseFilters(query) {
  return {
    preset: query.preset,
    from: query.from,
    to: query.to,
  };
}

export async function catalog(req, res, next) {
  try {
    success(res, {
      reportTypes: REPORT_TYPES,
      reportTypeLabels: REPORT_TYPE_LABELS,
      datePresets: DATE_PRESETS,
      exportFormats: EXPORT_FORMATS,
    });
  } catch (e) { next(e); }
}

export async function stats(req, res, next) {
  try {
    success(res, await reportService.getReportStats(req.factoryId, parseFilters(req.query)));
  } catch (e) { next(e); }
}

export async function factory(req, res, next) {
  try {
    success(res, await reportService.getFactoryDashboard(req.factoryId, parseFilters(req.query)));
  } catch (e) { next(e); }
}

export async function production(req, res, next) {
  try {
    success(res, await reportService.getProductionDashboard(req.factoryId, parseFilters(req.query)));
  } catch (e) { next(e); }
}

export async function inventory(req, res, next) {
  try {
    success(res, await reportService.getInventoryDashboard(req.factoryId, parseFilters(req.query)));
  } catch (e) { next(e); }
}

export async function purchase(req, res, next) {
  try {
    success(res, await reportService.getPurchaseDashboard(req.factoryId, parseFilters(req.query)));
  } catch (e) { next(e); }
}

export async function quality(req, res, next) {
  try {
    success(res, await reportService.getQualityDashboard(req.factoryId, parseFilters(req.query)));
  } catch (e) { next(e); }
}

export async function waste(req, res, next) {
  try {
    success(res, await reportService.getWasteDashboard(req.factoryId, parseFilters(req.query)));
  } catch (e) { next(e); }
}

export async function machine(req, res, next) {
  try {
    success(res, await reportService.getMachineDashboard(req.factoryId, parseFilters(req.query)));
  } catch (e) { next(e); }
}

export async function employee(req, res, next) {
  try {
    success(res, await reportService.getEmployeeDashboard(req.factoryId, parseFilters(req.query)));
  } catch (e) { next(e); }
}

export async function financial(req, res, next) {
  try {
    success(res, await reportService.getFinancialDashboard(req.factoryId, parseFilters(req.query)));
  } catch (e) { next(e); }
}

export async function approval(req, res, next) {
  try {
    success(res, await reportService.getApprovalDashboard(req.factoryId, parseFilters(req.query)));
  } catch (e) { next(e); }
}

export async function lowStock(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await reportService.listLowStockItems(req.factoryId, { page, limit, skip });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function pendingApprovals(req, res, next) {
  try {
    const { page, limit, skip } = paginate(req.query);
    const { items, total } = await reportService.listPendingApprovals(req.factoryId, { page, limit, skip });
    success(res, items, buildMeta(page, limit, total));
  } catch (e) { next(e); }
}

export async function topDefects(req, res, next) {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit || '10', 10)));
    success(res, await reportService.listTopDefects(req.factoryId, limit, parseFilters(req.query)));
  } catch (e) { next(e); }
}

export async function exportCsv(req, res, next) {
  try {
    const type = req.params.type;
    if (!dashboardHandlers[type]) {
      return res.status(404).json({ success: false, message: 'Unknown report type' });
    }
    const csv = await reportService.exportReportCsv(req.factoryId, type, parseFilters(req.query));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${type}-report.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
}
