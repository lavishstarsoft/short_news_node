const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true, 
    unique: true,
    trim: true,
    minlength: 2,
    maxlength: 50
  },
  localName: { 
    type: String, 
    required: false,
    trim: true,
    maxlength: 100
  },
  teluguName: { 
    type: String, 
    required: false,
    trim: true,
    maxlength: 100
  },
  code: { 
    type: String, 
    required: true,
    unique: true,
    trim: true,
    minlength: 2,
    maxlength: 10
  },
  locationType: {
    type: String,
    enum: ['country', 'state', 'district', 'constituency', 'scope'],
    default: 'state'
  },
  parent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Location',
    default: null
  },
  // True administrative state, preserved when a district's app-hierarchy parent
  // differs from its legal state (e.g. NCR districts shown under "Delhi").
  // Display/grouping uses parentName; this retains the real state for audit/truth.
  administrativeState: {
    type: String,
    default: null
  },
  parentName: {
    type: String,
    default: null
  },
  coordinates: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null }
  },
  languages: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  isActive: { 
    type: Boolean, 
    default: true 
  },
  newsCount: { 
    type: Number, 
    default: 0 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Update the updatedAt field before saving
locationSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

locationSchema.index({ locationType: 1, isActive: 1 });
locationSchema.index({ parent: 1 });
locationSchema.index({ parentName: 1 });

// Static method to get active locations (backward compatible)
locationSchema.statics.getActiveLocations = function() {
  return this.find({ isActive: true }).sort({ name: 1 });
};

// Get states only
locationSchema.statics.getActiveStates = function() {
  return this.find({ isActive: true, locationType: 'state' }).sort({ name: 1 });
};

// Get districts for a given state
locationSchema.statics.getDistrictsForState = function(stateName) {
  return this.find({ isActive: true, locationType: 'district', parentName: stateName }).sort({ name: 1 });
};

// Get full hierarchy tree (states → districts → constituencies)
locationSchema.statics.getHierarchy = async function() {
  const states = await this.find({ isActive: true, locationType: 'state' }).sort({ name: 1 }).lean();
  const districts = await this.find({ isActive: true, locationType: 'district' }).sort({ name: 1 }).lean();
  const constituencies = await this.find({ isActive: true, locationType: 'constituency' }).sort({ name: 1 }).lean();

  return states.map(state => ({
    ...state,
    districts: districts
      .filter(d => d.parentName === state.name)
      .map(d => ({
        ...d,
        constituencies: constituencies.filter(c => c.parentName === d.name)
      }))
  }));
};

module.exports = mongoose.model('Location', locationSchema);