import { ApprovalInstance } from '../../modules/approval/approvalInstance.model.js';

export async function findPendingApproval(documentType, documentId) {
  return ApprovalInstance.findOne({ documentType, documentId, status: 'PENDING' });
}

export async function syncApprovalApproved(documentType, documentId, approverId, comments) {
  const instance = await findPendingApproval(documentType, documentId);
  if (!instance) return null;
  instance.steps.push({
    level: instance.currentLevel,
    approverId,
    action: 'APPROVED',
    comments,
    actionAt: new Date(),
  });
  instance.status = 'APPROVED';
  instance.completedAt = new Date();
  await instance.save();
  return instance;
}

export async function syncApprovalRejected(documentType, documentId, approverId, comments) {
  const instance = await findPendingApproval(documentType, documentId);
  if (!instance) return null;
  instance.steps.push({
    level: instance.currentLevel,
    approverId,
    action: 'REJECTED',
    comments,
    actionAt: new Date(),
  });
  instance.status = 'REJECTED';
  instance.completedAt = new Date();
  await instance.save();
  return instance;
}

export async function syncApprovalRevisionRequested(documentType, documentId, approverId, comments) {
  const instance = await findPendingApproval(documentType, documentId);
  if (!instance) return null;
  instance.steps.push({
    level: instance.currentLevel,
    approverId,
    action: 'CHANGES_REQUESTED',
    comments,
    actionAt: new Date(),
  });
  instance.status = 'CHANGES_REQUESTED';
  instance.completedAt = new Date();
  await instance.save();
  return instance;
}
