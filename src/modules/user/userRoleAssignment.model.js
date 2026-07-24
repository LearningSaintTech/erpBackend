import mongoose from 'mongoose';

const userRoleAssignmentSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', required: true },
  factoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Factory', required: true },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assignedAt: { type: Date, default: Date.now },
  expiresAt: Date,
});

userRoleAssignmentSchema.index({ userId: 1, factoryId: 1, roleId: 1 }, { unique: true });

export const UserRoleAssignment = mongoose.model('UserRoleAssignment', userRoleAssignmentSchema);
