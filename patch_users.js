const fs = require('fs');
let content = fs.readFileSync('views/users.ejs', 'utf8');

// 1. Add deviceFingerprint to usersPageData
content = content.replace(
  'lastLogin: u.lastLogin,',
  'lastLogin: u.lastLogin,\n                        deviceFingerprint: u.deviceFingerprint,'
);

// 2. Add Device Fingerprint and Block button to modal UI
content = content.replace(
  /'<div class="usr-info-row"><span class="usr-info-label">Last login<\/span><span class="usr-info-value">' \+ formatDate\(user.lastLogin\) \+ '<\/span><\/div>' \+/,
  `'<div class="usr-info-row"><span class="usr-info-label">Last login</span><span class="usr-info-value">' + formatDate(user.lastLogin) + '</span></div>' +
                                    (user.deviceFingerprint ? 
                                        '<div class="usr-info-row mt-3"><span class="usr-info-label">Device ID</span><span class="usr-info-value"><span class="badge bg-secondary">' + escapeHtml(user.deviceFingerprint) + '</span></span></div>' +
                                        '<div class="usr-info-row"><button class="btn btn-sm btn-outline-danger w-100 mt-2" onclick="blockDevice(\\'' + escapeHtml(user.deviceFingerprint) + '\\')"><i class="fas fa-ban"></i> Block Device</button></div>' 
                                        : '') +`
);

// 3. Add blockDevice JS function
content = content.replace(
  'function toggleUserStatus(userId) {',
  `async function blockDevice(fingerprint) {
                    if (!confirm('Are you sure you want to block this device fingerprint? Any future referrals from this device will be rejected.')) return;
                    try {
                        const res = await fetch('/admin/security/block', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ type: 'device', identifier: fingerprint, reason: 'Blocked from Users dashboard' })
                        });
                        const data = await res.json();
                        if (data.success) {
                            alert('Device successfully blocked!');
                        } else {
                            alert(data.message || 'Error blocking device');
                        }
                    } catch (err) {
                        alert('Server error while blocking device');
                    }
                }

                function toggleUserStatus(userId) {`
);

fs.writeFileSync('views/users.ejs', content);
