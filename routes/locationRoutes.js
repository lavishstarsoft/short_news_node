const express = require('express');
const router = express.Router();
const locationController = require('../controllers/locationController');
const { requireAuth } = require('../controllers/adminController');

// Apply auth middleware to all routes
router.use(requireAuth);

// Get locations page
router.get('/', (req, res) => {
  // Render the locations page with empty locations array
  // The page will load locations via AJAX
  res.render('locations', { locations: [], admin: req.admin });
});

// Get all locations API
router.get('/api/locations', locationController.getAllLocations);

// Get single location
router.get('/api/locations/:id', locationController.getLocationById);

// Create new location
router.post('/api/locations', locationController.createLocation);

// Update location
router.put('/api/locations/:id', locationController.updateLocation);

// Delete location
router.delete('/api/locations/:id', locationController.deleteLocation);

// Toggle location status
router.patch('/api/locations/:id/toggle', locationController.toggleLocationStatus);

module.exports = router;