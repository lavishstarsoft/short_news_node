// Global Admin Notification System
// This file handles real-time notifications across all admin pages

(function () {
    'use strict';

    // Prevent multiple initializations
    if (window.adminNotificationsInitialized) return;
    window.adminNotificationsInitialized = true;

    // Initialize Socket.io connection (cookie JWT joins admin room server-side)
    const socket = io({
        withCredentials: true,
        transports: ['websocket', 'polling'],
    });

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** Same eligibility rules for new_news and resubmit toasts (subeditor scope). */
    function isNewsVisibleToCurrentAdmin(news) {
        if (!window.CURRENT_ADMIN || window.CURRENT_ADMIN.role !== 'subeditor') {
            return true;
        }
        const admin = window.CURRENT_ADMIN;
        const permissions = admin.permissions || {};

        if (admin.workingLanguage && admin.workingLanguage !== 'all' && news.language && news.language !== admin.workingLanguage) {
            return false;
        }

        if (permissions.approvalScope === 'geography') {
            const states = permissions.managedStates || [];
            const districts = permissions.managedDistricts || [];
            const constituencies = permissions.managedConstituencies || [];
            const legacyLocations = permissions.managedLocations || [];

            let hasAccess = false;
            if (news.state && states.includes(news.state)) hasAccess = true;
            if (news.district && districts.includes(news.district)) hasAccess = true;
            if (news.constituency && constituencies.includes(news.constituency)) hasAccess = true;
            if (news.location && legacyLocations.includes(news.location)) hasAccess = true;

            if (!hasAccess && (states.length > 0 || districts.length > 0 || constituencies.length > 0 || legacyLocations.length > 0)) {
                return false;
            }
        } else if (permissions.approvalScope === 'reporters') {
            const reporterIds = permissions.managedReporterIds || [];
            if (reporterIds.length > 0 && news.authorId && !reporterIds.includes(news.authorId) && !reporterIds.includes(String(news.authorId))) {
                return false;
            }
        }
        return true;
    }

    // Notification sound element
    let notificationSound = null;

    // Initialize on DOM ready
    document.addEventListener('DOMContentLoaded', function () {
        initializeNotificationSound();
        setupSocketListeners();
    });

    // Initialize notification sound
    function initializeNotificationSound() {
        notificationSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
        notificationSound.preload = 'auto';
    }

    // Setup Socket.io event listeners
    function setupSocketListeners() {
        // Listen for new comment reports
        socket.on('new_comment_report', function (data) {
            playNotificationSound();
            showToastNotification(data);
            document.dispatchEvent(new CustomEvent('new_comment_report_received', { detail: data }));
        });

        // Listen for new news reports
        socket.on('new_news_report', function (data) {
            playNotificationSound();
            showToastNotification({
                type: 'News Report',
                reason: data.reason,
                reportedBy: data.reportedBy
            });
            document.dispatchEvent(new CustomEvent('new_news_report_received', { detail: data }));
        });

        // Listen for new pending news submissions
        socket.on('new_news', function (news) {
            if (!isNewsVisibleToCurrentAdmin(news || {})) {
                return;
            }

            playNotificationSound();
            
            const title = `New Pending Story`;
            const safeTitle = escapeHtml(news.title || 'Untitled');
            const safeAuthor = escapeHtml(news.author || 'Reporter');
            const content = `"${safeTitle}" submitted by ${safeAuthor}. <br><a href="/admin/pending-news" class="text-white text-decoration-underline mt-1 d-inline-block">Click here to view</a>`;
            
            if (typeof window.showToast === 'function') {
                window.showToast(title, content, 'success');
            }
            
            document.dispatchEvent(new CustomEvent('new_pending_news_received', { detail: news }));
        });

        // Workflow sync for all admin pages (resubmit / approve / reject / send-back)
        socket.on('story_status_updated_admin', function (payload) {
            if (!payload || !payload.status) return;

            document.dispatchEvent(new CustomEvent('story_status_updated_admin_received', { detail: payload }));

            // Toast only for reporter resubmit — same eligibility as new_news for subeditors
            if (payload.status === 'resubmitted') {
                if (!isNewsVisibleToCurrentAdmin(payload)) {
                    return;
                }
                playNotificationSound();
                const title = 'Reporter Resubmitted';
                const safeTitle = escapeHtml(payload.title || 'Article');
                const content = `"${safeTitle}" is waiting for review. <br><a href="/admin/pending-news" class="text-white text-decoration-underline mt-1 d-inline-block">Open pending news</a>`;
                if (typeof window.showToast === 'function') {
                    window.showToast(title, content, 'warning');
                }
            }
        });

        // Connection status
        socket.on('connect', function () {
            // no-op
        });

        socket.on('disconnect', function () {
            // no-op
        });
    }

    // Play notification sound
    function playNotificationSound() {
        if (notificationSound) {
            notificationSound.currentTime = 0;
            notificationSound.play().catch(function () {
                // autoplay may be blocked — ignore
            });
        }
    }

    // Show toast notification
    function showToastNotification(data) {
        // Create toast container if it doesn't exist
        let toastContainer = document.getElementById('globalNotificationToastContainer');
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.id = 'globalNotificationToastContainer';
            toastContainer.className = 'toast-container position-fixed top-0 end-0 p-3';
            toastContainer.style.zIndex = '9999';
            document.body.appendChild(toastContainer);
        }

        // Create toast element
        const toastId = 'toast-' + Date.now();
        const toastHTML = `
            <div id="${toastId}" class="toast align-items-center text-white bg-danger border-0" role="alert" aria-live="assertive" aria-atomic="true">
                <div class="d-flex">
                    <div class="toast-body">
                        <strong><i class="fas fa-exclamation-triangle me-2"></i>New Report: ${data.reason || 'Unknown'}</strong><br>
                        <small>Comment reported by ${data.reportedBy || 'Anonymous'}</small>
                    </div>
                    <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
                </div>
            </div>
        `;

        // Add toast to container
        toastContainer.insertAdjacentHTML('beforeend', toastHTML);

        // Show toast using Bootstrap
        const toastElement = document.getElementById(toastId);
        const toast = new bootstrap.Toast(toastElement, {
            autohide: true,
            delay: 5000
        });
        toast.show();

        // Remove toast from DOM after it's hidden
        toastElement.addEventListener('hidden.bs.toast', function () {
            toastElement.remove();
        });
    }

    // Generic global toast
    window.showToast = function (title, message, type = 'danger') {
        let toastContainer = document.getElementById('globalNotificationToastContainer');
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.id = 'globalNotificationToastContainer';
            toastContainer.className = 'toast-container position-fixed top-0 end-0 p-3';
            toastContainer.style.zIndex = '9999';
            document.body.appendChild(toastContainer);
        }

        const toastId = 'toast-' + Date.now();
        const bgClass = type === 'success' ? 'bg-success' : (type === 'warning' ? 'bg-warning' : 'bg-danger');

        const toastHTML = `
            <div id="${toastId}" class="toast align-items-center text-white ${bgClass} border-0" role="alert" aria-live="assertive" aria-atomic="true">
                <div class="d-flex">
                    <div class="toast-body">
                        <strong>${title}</strong><br>
                        ${message}
                    </div>
                    <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
                </div>
            </div>
        `;

        toastContainer.insertAdjacentHTML('beforeend', toastHTML);
        const toastElement = document.getElementById(toastId);
        if (typeof bootstrap !== 'undefined') {
            const toast = new bootstrap.Toast(toastElement, { delay: 5000 });
            toast.show();
            toastElement.addEventListener('hidden.bs.toast', function () {
                toastElement.remove();
            });
        } else {
            toastElement.classList.add('show');
            setTimeout(() => toastElement.remove(), 5000);
        }
    };

    // Expose socket to global scope for page-specific use if needed
    window.adminNotificationSocket = socket;
    document.dispatchEvent(new CustomEvent('admin_socket_ready'));

})();
