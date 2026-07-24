import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { auditFields } from '../../shared/utils/schema.js';

const userSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  phone: String,
  employeeId: String,
  avatarUrl: String,
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'LOCKED'], default: 'ACTIVE' },
  isSuperAdmin: { type: Boolean, default: false },
  lastLoginAt: Date,
  passwordResetRequired: { type: Boolean, default: false },
  failedLoginAttempts: { type: Number, default: 0 },
  lockedUntil: Date,
  ...auditFields,
});

userSchema.index({ organizationId: 1, email: 1 }, { unique: true, sparse: true });
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { isSuperAdmin: true } });

userSchema.methods.comparePassword = async function (password) {
  return bcrypt.compare(password, this.passwordHash);
};

userSchema.statics.hashPassword = async function (password) {
  return bcrypt.hash(password, 12);
};

export const User = mongoose.model('User', userSchema);
