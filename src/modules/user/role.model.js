import mongoose from 'mongoose';

const roleSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
  code: { type: String, required: true },
  name: { type: String, required: true },
  permissions: [{ type: String }],
  isSystem: { type: Boolean, default: false },
  isCustom: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

roleSchema.index({ organizationId: 1, code: 1 }, { unique: true });

export const Role = mongoose.model('Role', roleSchema);
