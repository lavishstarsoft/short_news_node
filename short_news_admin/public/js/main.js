// Client-side JavaScript for the admin dashboard

// Add News Function
async function addNews() {
    const title = document.getElementById('title').value;
    const content = document.getElementById('content').value;
    const imageUrl = document.getElementById('imageUrl').value;
    const category = document.getElementById('category').value;
    const author = document.getElementById('author').value;

    // Validation
    if (!title || !content || !imageUrl || !category || !author) {
        showFeedback('Please fill in all fields', 'error');
        return;
    }

    const newsData = {
        title,
        content,
        imageUrl,
        category,
        author
    };

    try {
        const response = await fetch('/news/api/news', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(newsData)
        });

        if (response.ok) {
            // Show success feedback
            showFeedback('News added successfully!', 'success');
            document.getElementById('addNewsForm').reset();
            // Close modal
            const modal = bootstrap.Modal.getInstance(document.getElementById('addNewsModal'));
            modal.hide();
            // Reload page to show new news after a short delay
            setTimeout(() => {
                location.reload();
            }, 1500);
        } else {
            const error = await response.json();
            showFeedback('Error adding news: ' + error.error, 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showFeedback('Error adding news', 'error');
    }
}

// Edit News Function
function editNews(id) {
    showFeedback('Edit functionality would be implemented here. News ID: ' + id, 'info');
    // In a full implementation, this would open a modal with the news data pre-filled
}

// Delete News Function
async function deleteNews(id) {
    if (confirm('Are you sure you want to delete this news?')) {
        try {
            const response = await fetch(`/news/api/news/${id}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                showFeedback('News deleted successfully!', 'success');
                // Reload page to show updated news list after a short delay
                setTimeout(() => {
                    location.reload();
                }, 1500);
            } else {
                const error = await response.json();
                showFeedback('Error deleting news: ' + error.error, 'error');
            }
        } catch (error) {
            console.error('Error:', error);
            showFeedback('Error deleting news', 'error');
        }
    }
}

// Show feedback message (Android-like snackbar)
function showFeedback(message, type) {
    // Remove any existing feedback
    const existingFeedback = document.getElementById('feedback-toast');
    if (existingFeedback) {
        existingFeedback.remove();
    }

    // Create feedback element
    const feedback = document.createElement('div');
    feedback.id = 'feedback-toast';
    feedback.textContent = message;
    
    // Style based on type
    feedback.style.position = 'fixed';
    feedback.style.bottom = '20px';
    feedback.style.left = '50%';
    feedback.style.transform = 'translateX(-50%)';
    feedback.style.padding = '14px 24px';
    feedback.style.borderRadius = '4px';
    feedback.style.color = 'white';
    feedback.style.fontSize = '14px';
    feedback.style.fontWeight = '500';
    feedback.style.zIndex = '9999';
    feedback.style.boxShadow = '0 3px 5px -1px rgba(0,0,0,0.2), 0 6px 10px 0 rgba(0,0,0,0.14), 0 1px 18px 0 rgba(0,0,0,0.12)';
    feedback.style.maxWidth = '90%';
    feedback.style.width = 'auto';
    feedback.style.textAlign = 'center';
    feedback.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
    
    switch(type) {
        case 'success':
            feedback.style.backgroundColor = '#4CAF50';
            break;
        case 'error':
            feedback.style.backgroundColor = '#F44336';
            break;
        case 'info':
            feedback.style.backgroundColor = '#2196F3';
            break;
        default:
            feedback.style.backgroundColor = '#323232';
    }
    
    // Add to document
    document.body.appendChild(feedback);
    
    // Animate in
    feedback.style.opacity = '0';
    feedback.style.transform = 'translateX(-50%) translateY(20px)';
    setTimeout(() => {
        feedback.style.opacity = '1';
        feedback.style.transform = 'translateX(-50%) translateY(0)';
    }, 10);
    
    // Remove after delay with animation
    setTimeout(() => {
        feedback.style.opacity = '0';
        feedback.style.transform = 'translateX(-50%) translateY(20px)';
        setTimeout(() => {
            if (feedback.parentNode) {
                feedback.parentNode.removeChild(feedback);
            }
        }, 300);
    }, 3000);
}

// Initialize tooltips and add ripple effects
document.addEventListener('DOMContentLoaded', function() {
    // Initialize Bootstrap tooltips
    var tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    var tooltipList = tooltipTriggerList.map(function (tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl);
    });
    
    // Handle form submission on Enter key in form fields
    const formFields = document.querySelectorAll('#addNewsForm input, #addNewsForm textarea, #addNewsForm select');
    formFields.forEach(field => {
        field.addEventListener('keypress', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                if (field.tagName === 'TEXTAREA') return; // Allow Enter in textarea
                e.preventDefault();
                // Move to next field or submit if last field
                const form = document.getElementById('addNewsForm');
                const fields = Array.from(form.querySelectorAll('input, textarea, select'));
                const index = fields.indexOf(field);
                if (index < fields.length - 1) {
                    fields[index + 1].focus();
                } else {
                    addNews();
                }
            }
        });
    });
});