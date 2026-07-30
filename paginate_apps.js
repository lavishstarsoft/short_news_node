const fs = require('fs');
const path = require('path');

// 1. Update adminController.js
const ctrlPath = path.join(__dirname, 'controllers', 'adminController.js');
let ctrlContent = fs.readFileSync(ctrlPath, 'utf-8');

const oldCtrl = `    const applications = await ReporterApplication.find().sort({ createdAt: -1 }).lean();`;
const newCtrl = `    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const skip = (page - 1) * limit;
    
    const applications = await ReporterApplication.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean();
    const totalApps = await ReporterApplication.countDocuments();
    const totalPages = Math.ceil(totalApps / limit);
    
    // Add pagination info to res.locals so it's accessible in the view
    res.locals.pagination = { page, limit, totalApps, totalPages };`;

if (ctrlContent.includes(oldCtrl)) {
    ctrlContent = ctrlContent.replace(oldCtrl, newCtrl);
    fs.writeFileSync(ctrlPath, ctrlContent);
    console.log('Updated adminController.js');
} else {
    console.log('Could not find oldCtrl string in adminController.js');
}

// 2. Update reporter-applications.ejs
const ejsPath = path.join(__dirname, 'views', 'reporter-applications.ejs');
let ejsContent = fs.readFileSync(ejsPath, 'utf-8');

// Replace the count display
const oldCountDisplay = `<span class="text-muted" style="font-size:0.8rem;">Showing <strong id="raVisibleCount"><%= raApps.length %></strong> of <%= raApps.length %></span>`;
const newCountDisplay = `<span class="text-muted" style="font-size:0.8rem;">Showing <strong id="raVisibleCount"><%= raApps.length %></strong> (Page <%= typeof pagination !== 'undefined' ? pagination.page : 1 %> of <%= typeof pagination !== 'undefined' ? pagination.totalPages : 1 %>)</span>`;
if (ejsContent.includes(oldCountDisplay)) {
    ejsContent = ejsContent.replace(oldCountDisplay, newCountDisplay);
}

// Add pagination UI at the end of raQueue
const endQueue = `<div class="ra-queue" id="raQueue">`;
const endQueueClose = `                </div>\n                <% } %>`;

const paginationHtml = `
                </div>
                
                <% if (typeof pagination !== 'undefined' && pagination.totalPages > 1) { %>
                <div class="d-flex justify-content-center mt-4 mb-2">
                    <nav aria-label="Page navigation">
                        <ul class="pagination pagination-sm shadow-sm" style="border-radius: 8px; overflow: hidden;">
                            <li class="page-item <%= pagination.page <= 1 ? 'disabled' : '' %>">
                                <a class="page-link" href="?page=<%= pagination.page - 1 %>" style="border-color: #e5e7eb; color: #4f46e5; font-weight: 500;">Previous</a>
                            </li>
                            
                            <% 
                            let startPage = Math.max(1, pagination.page - 2);
                            let endPage = Math.min(pagination.totalPages, pagination.page + 2);
                            if (endPage - startPage < 4) {
                                if (startPage === 1) endPage = Math.min(pagination.totalPages, 5);
                                else if (endPage === pagination.totalPages) startPage = Math.max(1, pagination.totalPages - 4);
                            }
                            %>
                            
                            <% if (startPage > 1) { %>
                                <li class="page-item"><a class="page-link" href="?page=1" style="border-color: #e5e7eb; color: #6b7280;">1</a></li>
                                <% if (startPage > 2) { %>
                                    <li class="page-item disabled"><span class="page-link" style="border-color: #e5e7eb; color: #9ca3af;">...</span></li>
                                <% } %>
                            <% } %>
                            
                            <% for(let i = startPage; i <= endPage; i++) { %>
                                <li class="page-item <%= pagination.page === i ? 'active' : '' %>">
                                    <a class="page-link" href="?page=<%= i %>" 
                                       style="<%= pagination.page === i ? 'background-color: #4f46e5; border-color: #4f46e5; color: white;' : 'border-color: #e5e7eb; color: #6b7280;' %>">
                                        <%= i %>
                                    </a>
                                </li>
                            <% } %>
                            
                            <% if (endPage < pagination.totalPages) { %>
                                <% if (endPage < pagination.totalPages - 1) { %>
                                    <li class="page-item disabled"><span class="page-link" style="border-color: #e5e7eb; color: #9ca3af;">...</span></li>
                                <% } %>
                                <li class="page-item"><a class="page-link" href="?page=<%= pagination.totalPages %>" style="border-color: #e5e7eb; color: #6b7280;"><%= pagination.totalPages %></a></li>
                            <% } %>
                            
                            <li class="page-item <%= pagination.page >= pagination.totalPages ? 'disabled' : '' %>">
                                <a class="page-link" href="?page=<%= pagination.page + 1 %>" style="border-color: #e5e7eb; color: #4f46e5; font-weight: 500;">Next</a>
                            </li>
                        </ul>
                    </nav>
                </div>
                <% } %>
                
                <% } %>
`;

ejsContent = ejsContent.replace(endQueueClose, paginationHtml);
fs.writeFileSync(ejsPath, ejsContent);
console.log('Updated reporter-applications.ejs');

