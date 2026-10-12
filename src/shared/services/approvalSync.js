import { ApprovalInstance } from '../../modules/approval/approvalInstance.model.js';
import { ApprovalWorkflow } from '../../modules/approval/approvalWorkflow.model.js';
import { ConflictError, ForbiddenError } from '../errors/AppError.js';

export async function findPendingApproval(documentType, documentId) {
  return ApprovalInstance.findOne({ documentType, documentId, status: 'PENDING' });
}

/**
 * Close the pending instance from a module's direct approve/reject/revise endpoint.
 * Atomic on (status, currentLevel) so it cannot race an inbox action.
 */
async function closePending(documentType, documentId, approverId, comments, action, status) {
  const instance = await findPendingApproval(documentType, documentId);
  if (!instance) return null;

  // Four-eyes: the person who submitted can't approve it themselves at level 1 — the same rule
  // the Approvals inbox enforces (assertCanAct). Super admin is exempt.
  if (action === 'APPROVED' && String(instance.submittedBy) === String(approverId) && (instance.currentLevel ?? 1) <= 1) {
    const { User } = await import('../../modules/user/user.model.js');
    const approver = await User.findById(approverId).select('isSuperAdmin').lean();
    if (!approver?.isSuperAdmin) {
      throw new ForbiddenError('You submitted this — another approver must approve it');
    }
  }

  if (action === 'APPROVED' && instance.workflowId) {
    // A direct approve must not skip the remaining levels of a configured multi-level workflow.
    const workflow = await ApprovalWorkflow.findById(instance.workflowId);
    const maxLevel = workflow?.levels?.length ? Math.max(...workflow.levels.map((l) => l.level)) : 1;
    if ((instance.currentLevel ?? 1) < maxLevel) {
      throw new ConflictError(
        `This document needs ${maxLevel}-level approval — approve it from the Approvals inbox`,
      );
    }
  }

  const closed = await ApprovalInstance.findOneAndUpdate(
    { _id: instance._id, status: 'PENDING', currentLevel: instance.currentLevel },
    {
      $set: { status, completedAt: new Date() },
      $push: { steps: { level: instance.currentLevel, approverId, action, comments, actionAt: new Date() } },
    },
    { new: true },
  );
  if (!closed) throw new ConflictError('Approval was already actioned');
  // Lazy import: approval.service imports module services that import this file.
  const { notifySubmitterOfOutcome } = await import('../../modules/approval/approval.service.js');
  await notifySubmitterOfOutcome(closed);
  return closed;
}

export async function syncApprovalApproved(documentType, documentId, approverId, comments) {
  return closePending(documentType, documentId, approverId, comments, 'APPROVED', 'APPROVED');
}

export async function syncApprovalRejected(documentType, documentId, approverId, comments) {
  return closePending(documentType, documentId, approverId, comments, 'REJECTED', 'REJECTED');
}

export async function syncApprovalRevisionRequested(documentType, documentId, approverId, comments) {
  return closePending(documentType, documentId, approverId, comments, 'CHANGES_REQUESTED', 'CHANGES_REQUESTED');
}

/**
 * The document left review another way (cancelled, withdrawn, deleted): close any PENDING
 * instance so it does not sit in the inbox as an un-actionable row. No-op when none is pending.
 */
export async function cancelPendingApproval(documentType, documentId, userId, comments = 'Document cancelled') {
  return ApprovalInstance.findOneAndUpdate(
    { documentType, documentId, status: 'PENDING' },
    {
      $set: { status: 'CANCELLED', completedAt: new Date() },
      $push: { steps: { approverId: userId, action: 'CANCELLED', comments, actionAt: new Date() } },
    },
    { new: true },
  );
}
