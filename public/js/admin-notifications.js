// Global Admin Notification System
// This file handles real-time notifications across all admin pages

(function () {
    'use strict';

    // Prevent multiple initializations
    if (window.adminNotificationsInitialized) return;
    window.adminNotificationsInitialized = true;

    // Initialize Socket.io connection
    const socket = io();

    // Notification sound element
    let notificationSound = null;

    // Initialize on DOM ready
    document.addEventListener('DOMContentLoaded', function () {
        initializeNotificationSound();
        setupSocketListeners();
        console.log('Global admin notifications initialized');
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
            console.log('New comment report received:', data);

            // Play notification sound
            playNotificationSound();

            // Show toast notification
            showToastNotification(data);

            // Dispatch event for page-specific handling
            document.dispatchEvent(new CustomEvent('new_comment_report_received', { detail: data }));
        });

        // Listen for new news reports
        socket.on('new_news_report', function (data) {
            console.log('New news report received:', data);
            playNotificationSound();
            showToastNotification({
                type: 'News Report',
                reason: data.reason,
                reportedBy: data.reportedBy
            });

            // Dispatch event for page-specific handling (e.g., reports page table reload)
            document.dispatchEvent(new CustomEvent('new_news_report_received', { detail: data }));
        });

        // Listen for new pending news submissions
        socket.on('new_news', function (news) {
            console.log('New pending news received:', news);

            // Client-side filtering based on permissions
            if (window.CURRENT_ADMIN && window.CURRENT_ADMIN.role === 'subeditor') {
                const admin = window.CURRENT_ADMIN;
                const permissions = admin.permissions || {};
                
                // 1. Check language match (if language filtering is enabled)
                if (admin.workingLanguage && admin.workingLanguage !== 'all' && news.language && news.language !== admin.workingLanguage) {
                    console.log('Ignoring news notification due to language mismatch');
                    return;
                }
                
                // 2. Check approval scope
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
                    
                    // If subeditor has assigned geographies but news doesn't match any of them
                    if (!hasAccess && (states.length > 0 || districts.length > 0 || constituencies.length > 0 || legacyLocations.length > 0)) {
                        console.log('Ignoring news notification due to geography mismatch');
                        return;
                    }
                } else if (permissions.approvalScope === 'reporters') {
                    const reporterIds = permissions.managedReporterIds || [];
                    if (reporterIds.length > 0 && news.authorId && !reporterIds.includes(news.authorId)) {
                        console.log('Ignoring news notification due to reporter mismatch');
                        return;
                    }
                }
            }

            playNotificationSound();
            
            const title = `🗞️ New Pending News!`;
            const content = `"${news.title}" submitted by ${news.author || 'Reporter'}. <br><a href="/admin/pending-news" class="text-white text-decoration-underline mt-1 d-inline-block">Click here to view</a>`;
            
            // Show toast 
            if (typeof window.showToast === 'function') {
                window.showToast(title, content, 'success');
            }
            
            // Dispatch event for pending-news page to update the grid organically
            document.dispatchEvent(new CustomEvent('new_pending_news_received', { detail: news }));
        });

        // Connection status
        socket.on('connect', function () {
            console.log('Admin notification socket connected');
        });

        socket.on('disconnect', function () {
            console.log('Admin notification socket disconnected');
        });
    }

    // Play notification sound
    function playNotificationSound() {
        if (notificationSound) {
            notificationSound.currentTime = 0;
            notificationSound.play().catch(function (error) {
                console.log('Could not play notification sound:', error);
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

})();
