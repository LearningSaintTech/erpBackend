import mongoose from 'mongoose';
import { auditFields } from '../../shared/utils/schema.js';

const organizationSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  name: { type: String, required: true },
  legalName: String,
  registrationNumber: String,
  address: mongoose.Schema.Types.Mixed,
  contact: mongoose.Schema.Types.Mixed,
  branding: {
    logoUrl: String,
    primaryColor: { type: String, default: '#1a56db' },
    faviconUrl: String,
  },
  defaultCurrency: { type: String, default: 'INR' },
  timezone: { type: String, default: 'Asia/Kolkata' },
  activeFinancialYearId: { type: mongoose.Schema.Types.ObjectId, ref: 'FinancialYear' },
  status: { type: String, enum: ['ACTIVE', 'SUSPENDED', 'ARCHIVED'], default: 'ACTIVE' },
  ...auditFields,
});

export const Organization = mongoose.model('Organization', organizationSchema);
