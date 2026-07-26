const fs = require('fs');
const file = '/Users/saisudhakarmanchala/projects/Shortnews_main_mac/Node/views/pending-news.ejs';
let content = fs.readFileSync(file, 'utf8');

// 1. Add pendingNews fallback at the top
content = content.replace(
    /const pendingLangLabels/g,
    `const pendingNews = [...(typeof myPendingNews !== "undefined" ? myPendingNews : []), ...(typeof teamPendingNews !== "undefined" ? teamPendingNews : [])];\n                                const pendingLangLabels`
);

// 2. Extract the news card template
const loopStartStr = `<% pendingNews.forEach((news) => { %>`;
const loopEndStr = `<% }); %>`;
const startIndex = content.indexOf(loopStartStr);
const endIndex = content.indexOf(loopEndStr, startIndex) + loopEndStr.length;

if (startIndex === -1 || endIndex === -1) {
    console.error('Could not find loop bounds');
    process.exit(1);
}

let cardHtml = content.substring(startIndex + loopStartStr.length, endIndex - loopEndStr.length);

// 3. Add AI badges inside the card
cardHtml = cardHtml.replace(
    /<span class="badge pn-badge-lang">.*?<\/span>/g,
    `$&
                                                                <% if (section.isAIQueue && news.aiStatus) { %>
                                                                    <% if (news.aiStatus === 'processing') { %>
                                                                        <span class="badge" style="background: #fbbf24; color: #000;"><i class="fas fa-hourglass-half"></i> ⏳ AI Checking</span>
                                                                    <% } else if (news.aiStatus === 'review_required') { %>
                                                                        <span class="badge" style="background: #ef4444; color: #fff;"><i class="fas fa-exclamation-triangle"></i> ⚠ Review Required</span>
                                                                    <% } else if (news.aiStatus === 'failed') { %>
                                                                        <span class="badge" style="background: #374151; color: #fff;"><i class="fas fa-times-circle"></i> ❌ AI Failed</span>
                                                                    <% } %>
                                                                <% } %>`
);

// 4. Update the buttons logic
cardHtml = cardHtml.replace(
    /<div class="card-actions">([\s\S]*?)<\/div>/,
    `<div class="card-actions">
                                                                <button type="button" class="btn-preview" onclick="openPreview('<%= news._id %>')"><i class="fas fa-pen-to-square"></i> Preview</button>
                                                                <button type="button" class="btn-preview" onclick="window.location.href='/edit-news/<%= news._id %>?source=pending'" style="background-color: #3b82f6; color: white;"><i class="fas fa-pen"></i> Edit</button>
                                                                
                                                                <% if (section.isAIQueue && news.aiStatus === 'review_required') { %>
                                                                    <button type="button" class="btn-approve" onclick='approveNews("<%= news._id %>", <%- JSON.stringify(news.title).replace(/'/g, "&#39;") %>)'><i class="fas fa-check"></i> Publish Anyway</button>
                                                                <% } else if (!section.isAIQueue) { %>
                                                                    <% if (news.duplicateCheck && news.duplicateCheck.matchCount > 0) { %>
                                                                        <button type="button" class="btn-duplicate" onclick="viewDuplicates('<%= news._id %>')"><i class="fas fa-clone"></i> Duplicates</button>
                                                                    <% } %>
                                                                    <% if (Number(rs.revisionCount) > 0 || rs.lastChangeSummary) { %>
                                                                        <button type="button" class="btn-compare" onclick="openCompareVersions('<%= news._id %>')"><i class="fas fa-code-compare"></i> Compare Versions</button>
                                                                    <% } %>
                                                                    <% if (canApproveNews) { %>
                                                                        <button type="button" class="btn-approve" onclick='approveNews("<%= news._id %>", <%- JSON.stringify(news.title).replace(/'/g, "&#39;") %>)'><i class="fas fa-check"></i> Approve</button>
                                                                        <button type="button" class="btn-send-back" onclick='openSendBackModal("<%= news._id %>", <%- JSON.stringify(news.title).replace(/'/g, "&#39;") %>)'><i class="fas fa-rotate-left"></i> Send Back for Edit</button>
                                                                        <button type="button" class="btn-reject" onclick='rejectNews("<%= news._id %>", <%- JSON.stringify(news.title).replace(/'/g, "&#39;") %>)'><i class="fas fa-xmark"></i> Reject</button>
                                                                    <% } %>
                                                                <% } %>
                                                            </div>`
);


const newLogic = `<% 
const newsSections = [];
if (typeof myPendingNews !== 'undefined' && myPendingNews.length > 0) {
    newsSections.push({ title: 'My AI Queue', list: myPendingNews, isAIQueue: true });
}
if (typeof teamPendingNews !== 'undefined') {
    newsSections.push({ title: 'Team Pending', list: teamPendingNews, isAIQueue: false });
}
%>
<% newsSections.forEach((section) => { %>
    <div class="section-header" style="margin: 20px 0 10px; padding-bottom: 10px; border-bottom: 1px solid #e2e8f0;">
        <h2 style="font-size: 1.25rem; font-weight: 600; color: #0f172a; margin: 0;"><%= section.title %></h2>
    </div>
    <% if (section.list && section.list.length > 0) { %>
        <div class="news-grid" id="newsGrid_<%= section.isAIQueue ? 'ai' : 'team' %>">
            <% section.list.forEach((news) => { %>
                ${cardHtml}
            <% }); %>
        </div>
    <% } else { %>
        <div class="empty-state pn-empty" style="padding: 20px;">
            <div class="empty-state-icon pn-empty-icon"><i class="fas fa-circle-check"></i></div>
            <h3 style="font-size: 1.1rem;">All caught up</h3>
            <p>No pending submissions waiting in <%= section.title %>.</p>
        </div>
    <% } %>
<% }); %>`;

// Replace the old grid block
const fullGridStart = content.lastIndexOf('<div class="news-grid"', startIndex);
const fullGridEnd = content.indexOf('</div>', endIndex) + 6;

content = content.substring(0, fullGridStart) + newLogic + content.substring(fullGridEnd);

fs.writeFileSync(file, content);
console.log('Update complete');
