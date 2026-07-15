const fs = require('fs');
let content = fs.readFileSync('views/security.ejs', 'utf8');

// 1. Add Clear Modal
const clearModalHTML = `
<!-- Clear Logs Modal -->
<div class="modal fade" id="clearModal" tabindex="-1">
    <div class="modal-dialog">
        <div class="modal-content">
            <div class="modal-header">
                <h5 class="modal-title text-danger"><i class="fas fa-trash-alt me-2"></i>Clear Device Logs & Unblock</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <p>This action will <strong>completely remove</strong> all referral tracking logs (clicks, installs, blocks) associated with this identifier, effectively treating it as a brand new device.</p>
                <form id="clearForm">
                    <input type="hidden" id="clearIdentifier">
                    <input type="hidden" id="clearType">
                    <div class="mb-3">
                        <label class="form-label fw-bold">Admin Password</label>
                        <input type="password" class="form-control" id="clearPassword" placeholder="Enter .env password to confirm" required>
                        <small class="text-muted">Requires USER_DELETE_PASSWORD from .env</small>
                    </div>
                </form>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                <button type="button" class="btn btn-danger" id="submitClear">Confirm Clear Logs</button>
            </div>
        </div>
    </div>
</div>
`;
content = content.replace('<!-- Block Modal -->', clearModalHTML + '\n<!-- Block Modal -->');

// 2. Update Unblock button
content = content.replace(
  '<button class="btn btn-sm btn-success unblock-btn" data-id="<%= block._id %>">Unblock</button>',
  '<button class="btn btn-sm btn-warning clear-btn" data-identifier="<%= block.identifier %>" data-type="<%= block.type %>">Clear Logs</button>'
);

// 3. Add Clear Logs JS handler and replace Unblock logic
const unblockJS = `    // Unblock
    document.querySelectorAll('.unblock-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Are you sure you want to unblock this?')) return;
            const id = btn.getAttribute('data-id');
            try {
                const res = await fetch(\`/admin/security/block/\${id}\`, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    location.reload();
                } else {
                    alert('Error unblocking');
                }
            } catch (err) {
                alert('Server error');
            }
        });
    });`;

const clearLogsJS = `    // Open Clear Logs Modal
    document.querySelectorAll('.clear-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('clearIdentifier').value = btn.getAttribute('data-identifier');
            document.getElementById('clearType').value = btn.getAttribute('data-type');
            document.getElementById('clearPassword').value = '';
            new bootstrap.Modal(document.getElementById('clearModal')).show();
        });
    });

    // Submit Clear Logs
    document.getElementById('submitClear').addEventListener('click', async () => {
        const identifier = document.getElementById('clearIdentifier').value;
        const type = document.getElementById('clearType').value;
        const password = document.getElementById('clearPassword').value;

        if (!password) {
            alert('Password is required');
            return;
        }

        try {
            const res = await fetch('/admin/security/clear', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier, type, password })
            });
            const data = await res.json();
            if (data.success) {
                alert(data.message);
                location.reload();
            } else {
                alert(data.message || 'Error clearing logs');
            }
        } catch (err) {
            console.error(err);
            alert('Server error');
        }
    });`;

content = content.replace(unblockJS, clearLogsJS);

// Also add a 'Clear' button to the device and IP aggregations rows to make it easy
content = content.replace(
  '<button class="btn btn-sm btn-outline-danger block-btn" data-id="<%= device._id %>" data-type="device">Block</button>',
  '<button class="btn btn-sm btn-outline-danger block-btn" data-id="<%= device._id %>" data-type="device">Block</button>\n                                                        <button class="btn btn-sm btn-outline-warning clear-btn ms-1" data-identifier="<%= device._id %>" data-type="device">Clear</button>'
);

content = content.replace(
  '<button class="btn btn-sm btn-outline-danger block-btn" data-id="<%= ip._id %>" data-type="ip">Block</button>',
  '<button class="btn btn-sm btn-outline-danger block-btn" data-id="<%= ip._id %>" data-type="ip">Block</button>\n                                                        <button class="btn btn-sm btn-outline-warning clear-btn ms-1" data-identifier="<%= ip._id %>" data-type="ip">Clear</button>'
);

fs.writeFileSync('views/security.ejs', content);
