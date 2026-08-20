import mongoose from 'mongoose';

const vehicleSchema = new mongoose.Schema({
    id: String,
    plate: String,
    type: { type: String, default: 'CAR' },
    is_parking_active: { type: Boolean, default: true },
    allocation_type: { type: String, default: 'BASE' },
    allocation_target_id: { type: String, default: null },
    unit_id: String,
}, { _id: false });

const residentSchema = new mongoose.Schema({
    id: String,
    apartment_id: String,
    unit_number: String,
    kind: String,
    full_name: String,
    phone: String,
    email: String,
    notes: String,
    is_primary: Boolean,
    is_residing: Boolean,
}, { _id: false });

const unitSchema = new mongoose.Schema({
    _id: { type: String },
    apartment_id: { type: String, index: true },
    number: String,
    block: String,
    bhk: String,
    area_sqft: Number,
    car_limit: { type: Number, default: 0 },
    bike_limit: { type: Number, default: 0 },
    occupancy_status: String,
    notes: String,
    is_community: { type: Boolean, default: false },
    vehicles: { type: [vehicleSchema], default: [] },
    residents: { type: [residentSchema], default: [] },
    _schema: Number,
    created_at: String,
    updated_at: String,
}, { collection: 'property_units', strict: false });

unitSchema.index({ apartment_id: 1, number: 1 }, { unique: true, name: 'apt_number' });

const slotSchema = new mongoose.Schema({
    _id: { type: String },
    id: String,
    apartment_id: { type: String, index: true },
    name: String,
    pool_kind: String,
    assigned_vehicle_id: { type: String, default: null },
    created_at: String,
}, { collection: 'property_slots', strict: false });

export const PropertyUnit = mongoose.models.PropertyUnit
    || mongoose.model('PropertyUnit', unitSchema);
export const PropertySlot = mongoose.models.PropertySlot
    || mongoose.model('PropertySlot', slotSchema);
