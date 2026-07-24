import mongoose from 'mongoose';

const permissionSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  module: { type: String, required: true },
  action: { type: String, required: true },
  description: String,
});

export const Permission = mongoose.model('Permission', permissionSchema);
