import * as designService from '../../modules/design/design.service.js';
import * as purchaseService from '../../modules/purchase/purchase.service.js';
import * as bomService from '../../modules/bom/bom.service.js';
import * as sampleService from '../../modules/sampling/sample.service.js';
import * as productionService from '../../modules/production/production.service.js';
import { ValidationError } from '../errors/AppError.js';

/**
 * Inbox outcomes each document type supports. Kept in sync with the frontend
 * (features/approvals/approvalUtils.ts APPROVAL_ACTIONS) so the inbox never offers
 * an action that would close the instance while leaving the document in review.
 */
export const SUPPORTED_APPROVAL_ACTIONS = {
  DESIGN: ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'],
  SAMPLE: ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'],
  SAMPLE_MATERIAL: ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'],
  PRODUCTION_ORDER: ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'],
  PURCHASE_REQUISITION: ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'],
  BOM: ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'],
};

function unsupported(documentType, status) {
  // Throwing makes finalizeInstance roll the instance back to PENDING instead of
  // closing it while the document silently stays in review.
  throw new ValidationError(`${documentType} does not support ${status} from the approvals inbox`);
}

export async function applyApprovalResult(instance, approverId) {
  const { documentType, documentId, status, factoryId } = instance;
  const comments = instance.steps?.at(-1)?.comments;
  const syncOff = { syncApproval: false };

  if (status === 'APPROVED') {
    switch (documentType) {
      case 'DESIGN':
        return designService.approveDesign(documentId, approverId, { ...syncOff, factoryId });
      case 'PURCHASE_REQUISITION':
        return purchaseService.approvePurchaseRequisition(documentId, factoryId, approverId, syncOff);
      case 'BOM':
        return bomService.approveBom(documentId, factoryId, approverId, syncOff);
      case 'SAMPLE_MATERIAL':
        return sampleService.approveMaterialRequest(documentId, factoryId, approverId, syncOff);
      case 'SAMPLE':
        return sampleService.approveSample(documentId, factoryId, approverId, syncOff);
      case 'PRODUCTION_ORDER':
        return productionService.approveProductionOrder(documentId, approverId, { ...syncOff, factoryId });
      default:
        return unsupported(documentType, status);
    }
  }
  if (status === 'REJECTED') {
    switch (documentType) {
      case 'DESIGN':
        return designService.rejectDesign(documentId, approverId, comments, { ...syncOff, factoryId });
      case 'PURCHASE_REQUISITION':
        return purchaseService.rejectPurchaseRequisition(documentId, factoryId, approverId, comments, syncOff);
      case 'BOM':
        return bomService.rejectBom(documentId, factoryId, approverId, comments, syncOff);
      case 'SAMPLE_MATERIAL':
        return sampleService.rejectMaterialRequest(documentId, factoryId, approverId, comments, syncOff);
      case 'SAMPLE':
        return sampleService.rejectSample(documentId, factoryId, approverId, comments, syncOff);
      case 'PRODUCTION_ORDER':
        return productionService.rejectProductionOrder(documentId, approverId, comments, { ...syncOff, factoryId });
      default:
        return unsupported(documentType, status);
    }
  }
  if (status === 'CHANGES_REQUESTED') {
    switch (documentType) {
      case 'DESIGN':
        return designService.requestRevision(documentId, approverId, comments, { ...syncOff, factoryId });
      case 'PURCHASE_REQUISITION':
        return purchaseService.requestPurchaseRequisitionChanges(documentId, factoryId, approverId, comments, syncOff);
      case 'BOM':
        return bomService.requestBomChanges(documentId, factoryId, approverId, comments, syncOff);
      case 'SAMPLE_MATERIAL':
        return sampleService.requestMaterialRequestChanges(documentId, factoryId, approverId, comments, syncOff);
      case 'SAMPLE':
        return sampleService.requestSampleRevision(documentId, factoryId, approverId, comments, syncOff);
      case 'PRODUCTION_ORDER':
        return productionService.requestProductionRevision(documentId, approverId, comments, { factoryId });
      default:
        return unsupported(documentType, status);
    }
  }
  return unsupported(documentType, status);
}
