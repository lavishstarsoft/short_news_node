const mongoose = require('mongoose');
const fs = require('fs');
const PDFDocument = require('pdfkit');
require('dotenv').config();
const Admin = require('./models/Admin');

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const reporters = await Admin.find({ role: 'editor' }).select('name assignedState assignedDistricts').lean();
    
    const grouped = {};
    for (const r of reporters) {
      const state = r.assignedState || 'Unknown State';
      const district = (r.assignedDistricts && r.assignedDistricts.length > 0) ? r.assignedDistricts[0] : 'Unknown District';
      
      if (!grouped[state]) grouped[state] = {};
      if (!grouped[state][district]) grouped[state][district] = [];
      grouped[state][district].push(r.name || 'Unnamed Reporter');
    }
    
    const dest = '/Users/saisudhakarmanchala/.gemini/antigravity-ide/brain/9e131cdb-d9dc-4857-b2fa-69029d5ab770/reporters_list.pdf';
    const doc = new PDFDocument({ margin: 50 });
    const writeStream = fs.createWriteStream(dest);
    doc.pipe(writeStream);
    
    // Header background
    doc.rect(0, 0, doc.page.width, 100).fill('#E31E24');
    
    doc.fontSize(28)
       .font('Helvetica-Bold')
       .fillColor('#FFFFFF')
       .text('ShortNews Reporters Directory', 0, 35, { align: 'center' });
    
    doc.fontSize(12)
       .fillColor('#FFDCDC')
       .text(`Generated on: ${new Date().toLocaleDateString('en-IN')}`, 0, 70, { align: 'center' });
    
    doc.moveDown(4); // Move past the header
    doc.y = 120; // reset y below header

    for (const state of Object.keys(grouped).sort()) {
      // Check space for state header
      if (doc.y > doc.page.height - 150) doc.addPage();
      
      // State Heading
      doc.moveDown(1.5);
      doc.rect(50, doc.y, doc.page.width - 100, 30).fill('#F3F4F6');
      doc.fontSize(16).fillColor('#1F2937').font('Helvetica-Bold').text(state, 60, doc.y + 7);
      doc.y += 20; // adjust y below the rect
      
      for (const district of Object.keys(grouped[state]).sort()) {
        if (doc.y > doc.page.height - 100) doc.addPage();
        
        doc.moveDown(1);
        doc.fontSize(14).fillColor('#E31E24').font('Helvetica-Bold').text(district, 60, doc.y);
        doc.moveDown(0.5);
        
        // Print names in a 2-column or 3-column grid
        const names = grouped[state][district].sort();
        const startY = doc.y;
        let currentY = startY;
        
        doc.fontSize(11).fillColor('#4B5563').font('Helvetica');
        
        for (let i = 0; i < names.length; i++) {
          const xOffset = 70 + (i % 3) * 160; 
          const row = Math.floor(i / 3);
          
          if (i > 0 && i % 3 === 0) {
             currentY += 20;
             if (currentY > doc.page.height - 70) {
                doc.addPage();
                currentY = doc.y;
             }
          }
          
          doc.text(`• ${names[i]}`, xOffset, currentY, { width: 150, ellipsis: true });
        }
        
        doc.y = currentY + 25; // Move down after the grid
      }
    }
    
    doc.end();
    writeStream.on('finish', () => {
      console.log('PDF generated successfully.');
      process.exit(0);
    });
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
run();
