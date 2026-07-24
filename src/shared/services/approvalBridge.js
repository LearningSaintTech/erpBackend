import * as designService from '../../modules/design/design.service.js';
import * as purchaseService from '../../modules/purchase/purchase.service.js';
import * as bomService from '../../modules/bom/bom.service.js';
import * as sampleService from '../../modules/sampling/sample.service.js';
import * as productionService from '../../modules/production/production.service.js';

export async function applyApprovalResult(instance, approverId) {
  const { documentType, documentId, status, factoryId } = instance;
  const comments = instance.steps?.at(-1)?.comments;
  const syncOff = { syncApproval: false };

  if (status === 'APPROVED') {
    switch (documentType) {
      case 'DESIGN':
        return designService.approveDesign(documentId, approverId, syncOff);
      case 'PURCHASE_REQUISITION':
        return purchaseService.approvePurchaseRequisition(documentId, factoryId, approverId, syncOff);
      case 'PURCHASE_ORDER':
        return purchaseService.approvePurchaseOrder(documentId, factoryId, approverId, syncOff);
      case 'BOM':
        return bomService.approveBom(documentId, factoryId, approverId);
      case 'SAMPLE_MATERIAL':
        return sampleService.approveMaterialRequest(documentId, factoryId, approverId, syncOff);
      case 'SAMPLE':
        return sampleService.approveSample(documentId, factoryId, approverId, syncOff);
      case 'PRODUCTION_ORDER':
        return productionService.approveProductionOrder(documentId, approverId, { ...syncOff, factoryId });
      default:
        return null;
    }
  }
  if (status === 'REJECTED') {
    switch (documentType) {
      case 'DESIGN':
        return designService.rejectDesign(documentId, approverId, comments, syncOff);
      case 'PURCHASE_REQUISITION':
        return purchaseService.rejectPurchaseRequisition(documentId, factoryId, approverId, comments, syncOff);
      case 'SAMPLE_MATERIAL':
        return sampleService.rejectMaterialRequest(documentId, factoryId, approverId, comments, syncOff);
      case 'SAMPLE':
        return sampleService.rejectSample(documentId, factoryId, approverId, comments, syncOff);
      case 'PRODUCTION_ORDER':
        return productionService.rejectProductionOrder(documentId, approverId, comments, { ...syncOff, factoryId });
      default:
        return null;
    }
  }
  if (status === 'CHANGES_REQUESTED') {
    switch (documentType) {
      case 'DESIGN':
        return designService.requestRevision(documentId, approverId, comments, syncOff);
      case 'SAMPLE':
        return sampleService.requestSampleRevision(documentId, factoryId, approverId, comments, syncOff);
      case 'PRODUCTION_ORDER':
        return productionService.requestProductionRevision(documentId, approverId, comments);
      default:
        return null;
    }
  }
  return null;
}
