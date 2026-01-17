const Location = require('../models/Location');
const News = require('../models/News');

// Get all locations
exports.getAllLocations = async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;
    
    if (isConnectedToMongoDB) {
      const locations = await Location.find().sort({ name: 1 });
      
      // Calculate news count for each location
      const locationsWithNewsCount = await Promise.all(locations.map(async (location) => {
        const newsCount = await News.countDocuments({ location: location.name });
        console.log(`Location: ${location.name}, News Count: ${newsCount}`); // Debug log
        return {
          ...location.toObject(),
          newsCount
        };
      }));
      
      res.json(locationsWithNewsCount);
    } else {
      // Use in-memory storage
      const locations = req.app.locals.locationData || [];
      
      // Calculate news count for each location
      const newsData = req.app.locals.newsData || [];
      const locationsWithNewsCount = locations.map(location => {
        const newsCount = newsData.filter(news => news.location === location.name).length;
        console.log(`Location: ${location.name}, News Count: ${newsCount}`); // Debug log
        return {
          ...location,
          newsCount
        };
      });
      
      res.json(locationsWithNewsCount);
    }
  } catch (error) {
    console.error('Error fetching locations:', error);
    res.status(500).json({ error: 'Error fetching locations' });
  }
};

// Get single location
exports.getLocationById = async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;
    
    if (isConnectedToMongoDB) {
      const location = await Location.findById(req.params.id);
      if (!location) {
        return res.status(404).json({ error: 'Location not found' });
      }
      
      // Calculate news count for this location
      const newsCount = await News.countDocuments({ location: location.name });
      console.log(`Single Location: ${location.name}, News Count: ${newsCount}`); // Debug log
      const locationWithNewsCount = {
        ...location.toObject(),
        newsCount
      };
      
      res.json(locationWithNewsCount);
    } else {
      // Use in-memory storage
      const locations = req.app.locals.locationData || [];
      const location = locations.find(loc => loc._id === req.params.id);
      if (!location) {
        return res.status(404).json({ error: 'Location not found' });
      }
      
      // Calculate news count for this location
      const newsData = req.app.locals.newsData || [];
      const newsCount = newsData.filter(news => news.location === location.name).length;
      console.log(`Single Location: ${location.name}, News Count: ${newsCount}`); // Debug log
      const locationWithNewsCount = {
        ...location,
        newsCount
      };
      
      res.json(locationWithNewsCount);
    }
  } catch (error) {
    console.error('Error fetching location:', error);
    res.status(500).json({ error: 'Error fetching location' });
  }
};

// Create new location
exports.createLocation = async (req, res) => {
  try {
    const { name, code, isActive } = req.body;
    
    // Validate required fields
    if (!name || !code) {
      return res.status(400).json({ 
        error: 'Name and code are required' 
      });
    }

    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;
    
    if (isConnectedToMongoDB) {
      // Check if location already exists
      const existingLocation = await Location.findOne({ 
        $or: [
          { name: { $regex: new RegExp(`^${name}$`, 'i') } },
          { code: { $regex: new RegExp(`^${code}$`, 'i') } }
        ]
      });
      
      if (existingLocation) {
        return res.status(400).json({ 
          error: 'Location with this name or code already exists' 
        });
      }

      const location = new Location({
        name: name.trim(),
        code: code.trim(),
        isActive: isActive !== false
      });

      await location.save();
      res.status(201).json(location);
    } else {
      // Use in-memory storage
      const locations = req.app.locals.locationData || [];
      
      // Check if location already exists
      const existingLocation = locations.find(loc => 
        loc.name.toLowerCase() === name.toLowerCase() || 
        loc.code.toLowerCase() === code.toLowerCase()
      );
      
      if (existingLocation) {
        return res.status(400).json({ 
          error: 'Location with this name or code already exists' 
        });
      }

      const newLocation = {
        _id: String(locations.length + 1),
        name: name.trim(),
        code: code.trim(),
        isActive: isActive !== false,
        newsCount: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      locations.push(newLocation);
      req.app.locals.locationData = locations;
      res.status(201).json(newLocation);
    }
  } catch (error) {
    console.error('Error creating location:', error);
    res.status(400).json({ error: 'Error creating location: ' + error.message });
  }
};

// Update location
exports.updateLocation = async (req, res) => {
  try {
    const { name, code, isActive } = req.body;
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;
    
    if (isConnectedToMongoDB) {
      const location = await Location.findById(req.params.id);
      if (!location) {
        return res.status(404).json({ error: 'Location not found' });
      }

      // Check if name or code is being changed and if it conflicts with existing
      if ((name && name !== location.name) || (code && code !== location.code)) {
        const existingLocation = await Location.findOne({ 
          $or: [
            { name: { $regex: new RegExp(`^${name}$`, 'i') } },
            { code: { $regex: new RegExp(`^${code}$`, 'i') } }
          ],
          _id: { $ne: req.params.id }
        });
        
        if (existingLocation) {
          return res.status(400).json({ 
            error: 'Location with this name or code already exists' 
          });
        }
      }

      // Update fields
      if (name) location.name = name.trim();
      if (code) location.code = code.trim();
      if (typeof isActive === 'boolean') location.isActive = isActive;

      await location.save();
      res.json(location);
    } else {
      // Use in-memory storage
      const locations = req.app.locals.locationData || [];
      const locationIndex = locations.findIndex(loc => loc._id === req.params.id);
      
      if (locationIndex === -1) {
        return res.status(404).json({ error: 'Location not found' });
      }

      const location = locations[locationIndex];

      // Check if name or code is being changed and if it conflicts with existing
      if ((name && name !== location.name) || (code && code !== location.code)) {
        const existingLocation = locations.find(loc => 
          (loc.name.toLowerCase() === name.toLowerCase() || 
           loc.code.toLowerCase() === code.toLowerCase()) && 
          loc._id !== req.params.id
        );
        
        if (existingLocation) {
          return res.status(400).json({ 
            error: 'Location with this name or code already exists' 
          });
        }
      }

      // Update fields
      if (name) location.name = name.trim();
      if (code) location.code = code.trim();
      if (typeof isActive === 'boolean') location.isActive = isActive;
      location.updatedAt = new Date();

      locations[locationIndex] = location;
      req.app.locals.locationData = locations;
      res.json(location);
    }
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(400).json({ error: 'Error updating location: ' + error.message });
  }
};

// Delete location
exports.deleteLocation = async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;
    
    if (isConnectedToMongoDB) {
      const location = await Location.findById(req.params.id);
      if (!location) {
        return res.status(404).json({ error: 'Location not found' });
      }

      // Check if location has associated news
      const newsData = req.app.locals.newsData || [];
      const newsCount = newsData.filter(news => news.location === location.name).length;
      
      if (newsCount > 0) {
        return res.status(400).json({ 
          error: `Cannot delete location. It has ${newsCount} associated news articles. Please reassign or delete the news first.` 
        });
      }

      await Location.findByIdAndDelete(req.params.id);
      res.json({ message: 'Location deleted successfully' });
    } else {
      // Use in-memory storage
      const locations = req.app.locals.locationData || [];
      const locationIndex = locations.findIndex(loc => loc._id === req.params.id);
      
      if (locationIndex === -1) {
        return res.status(404).json({ error: 'Location not found' });
      }

      const location = locations[locationIndex];

      // Check if location has associated news
      const newsData = req.app.locals.newsData || [];
      const newsCount = newsData.filter(news => news.location === location.name).length;
      
      if (newsCount > 0) {
        return res.status(400).json({ 
          error: `Cannot delete location. It has ${newsCount} associated news articles. Please reassign or delete the news first.` 
        });
      }

      locations.splice(locationIndex, 1);
      req.app.locals.locationData = locations;
      res.json({ message: 'Location deleted successfully' });
    }
  } catch (error) {
    console.error('Error deleting location:', error);
    res.status(400).json({ error: 'Error deleting location: ' + error.message });
  }
};

// Toggle location status
exports.toggleLocationStatus = async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;
    
    if (isConnectedToMongoDB) {
      const location = await Location.findById(req.params.id);
      if (!location) {
        return res.status(404).json({ error: 'Location not found' });
      }

      location.isActive = !location.isActive;
      await location.save();
      
      res.json({ 
        message: `Location ${location.isActive ? 'activated' : 'deactivated'} successfully`,
        location 
      });
    } else {
      // Use in-memory storage
      const locations = req.app.locals.locationData || [];
      const locationIndex = locations.findIndex(loc => loc._id === req.params.id);
      
      if (locationIndex === -1) {
        return res.status(404).json({ error: 'Location not found' });
      }

      const location = locations[locationIndex];
      location.isActive = !location.isActive;
      location.updatedAt = new Date();
      
      locations[locationIndex] = location;
      req.app.locals.locationData = locations;
      
      res.json({ 
        message: `Location ${location.isActive ? 'activated' : 'deactivated'} successfully`,
        location 
      });
    }
  } catch (error) {
    console.error('Error toggling location status:', error);
    res.status(400).json({ error: 'Error toggling location status: ' + error.message });
  }
};