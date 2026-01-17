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
