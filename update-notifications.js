const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'public/js/admin-notifications.js');
let code = fs.readFileSync(file, 'utf8');

const newCode = `
    // --- AI Queue Notifications ---
    let aiNotificationSound = null;
    try {
        aiNotificationSound = new Audio('/sounds/ai-alert.wav');
    } catch (e) {
        console.warn('Could not load AI alert sound', e);
    }

    if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
        Notification.requestPermission();
    }

    socket.on('ai_status_updated', function (payload) {
        if (!payload || !payload.id) return;
        
        let title = 'AI Verification Completed';
        let icon = 'ℹ️';
        if (payload.status === 'verified') {
            title = '✅ Article Published (AI)';
        } else if (payload.status === 'review_required') {
            title = '⚠️ AI Review Required';
        } else if (payload.status === 'failed') {
            title = '❌ AI Verification Failed';
        }

        const body = \`\${payload.title}\\nStatus: \${payload.status}\`;

        // Play Sound
        if (aiNotificationSound) {
            aiNotificationSound.play().catch(e => console.warn('Audio play prevented', e));
        }

        // Native Browser Notification
        if (Notification.permission === 'granted') {
            const notif = new Notification(title, {
                body: body,
                icon: '/images/logo.png', // Replace with actual logo if available
                tag: 'ai_queue_' + payload.id,
                requireInteraction: true
            });
            notif.onclick = function () {
                window.focus();
                window.location.href = '/admin/my-ai-queue#article-' + payload.id;
            };
        }

        // In-app Toast (Toastify)
        if (typeof Toastify !== 'undefined') {
            Toastify({
                text: \`\${title}\\n\${payload.title}\`,
                duration: 5000,
                close: true,
                gravity: 'top',
                position: 'right',
                style: {
                    background: payload.status === 'review_required' ? '#ef4444' : payload.status === 'verified' ? '#10b981' : '#374151',
                    color: '#fff',
                    borderRadius: '8px'
                },
                onClick: function() {
                    window.location.href = '/admin/my-ai-queue#article-' + payload.id;
                }
            }).showToast();
        }
        
        // If we are currently ON the AI queue page, we should update the UI or reload
        if (window.location.pathname.includes('my-ai-queue')) {
             setTimeout(() => window.location.reload(), 1500);
        }
    });
`;

code = code.replace(/}\)\(\);/g, newCode + '\n})();');
fs.writeFileSync(file, code);
console.log('Notifications updated successfully.');
