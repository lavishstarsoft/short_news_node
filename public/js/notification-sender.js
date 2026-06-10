/**
 * Shared OneSignal notification composer (dashboard + news list)
 */
(function (global) {
  let currentNotificationNewsItem = null;
  let selectedTitleColor = '#FF6F00';
  let selectedTitleFontSize = 'normal';

  function getNewsListSource() {
    if (Array.isArray(global.newsList)) return global.newsList;
    if (Array.isArray(global.newsListItems)) return global.newsListItems;
    return [];
  }

  function resetColorButtons() {
    document.querySelectorAll('#titleColorPresets .color-btn').forEach(function (btn) {
      btn.classList.remove('selected');
      if (btn.dataset.color === '#FF6F00') btn.classList.add('selected');
    });
    const custom = document.getElementById('customTitleColor');
    if (custom) custom.value = '#FF6F00';

    document.querySelectorAll('#titleFontSizePresets .font-size-btn').forEach(function (btn) {
      btn.classList.remove('selected');
      if (btn.dataset.size === 'normal') btn.classList.add('selected');
    });
  }

  function stripHtmlToPlainText(html) {
    if (!html) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.textContent || tmp.innerText || '')
      .replace(/\u00a0/g, ' ')
      .trim();
  }

  function resizeMessageTextarea() {
    const messageInput = document.getElementById('notifMessageInput');
    if (!messageInput) return;
    messageInput.style.height = 'auto';
    const maxHeight = 360;
    const nextHeight = Math.min(messageInput.scrollHeight, maxHeight);
    messageInput.style.height = nextHeight + 'px';
    messageInput.style.overflowY = messageInput.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  function populateNotificationFields(newsItem) {
    const titleInput = document.getElementById('notifTitleInput');
    const messageInput = document.getElementById('notifMessageInput');
    if (titleInput) titleInput.value = stripHtmlToPlainText(newsItem.title || '');
    if (messageInput) {
      messageInput.value = stripHtmlToPlainText(newsItem.content || '');
      resizeMessageTextarea();
    }
  }

  async function sendNotificationForNews(newsId) {
    let newsItem = getNewsListSource().find(function (news) {
      return String(news._id) === String(newsId);
    });

    if (!newsItem) {
      alert('News item not found');
      return;
    }

    if (newsItem.isActive === false) {
      alert('Activate this article before sending a push notification.');
      return;
    }

    try {
      const response = await fetch('/news/api/news/' + newsId);
      if (response.ok) {
        const latestNews = await response.json();
        newsItem = Object.assign({}, newsItem, latestNews);
      }
    } catch (error) {
      console.warn('Could not fetch latest news content for notification.', error);
    }

    currentNotificationNewsItem = newsItem;
    populateNotificationFields(newsItem);

    selectedTitleColor = '#FF6F00';
    selectedTitleFontSize = 'normal';
    resetColorButtons();
    updateNotifPreview();

    const modal = document.getElementById('notificationRichModal');
    if (modal) modal.classList.add('active');
  }

  function selectTitleColor(btn) {
    document.querySelectorAll('#titleColorPresets .color-btn').forEach(function (b) {
      b.classList.remove('selected');
    });
    btn.classList.add('selected');
    selectedTitleColor = btn.dataset.color;
    const custom = document.getElementById('customTitleColor');
    if (custom) custom.value = selectedTitleColor;
    updateNotifPreview();
  }

  function selectCustomTitleColor(color) {
    document.querySelectorAll('#titleColorPresets .color-btn').forEach(function (b) {
      b.classList.remove('selected');
    });
    selectedTitleColor = color;
    updateNotifPreview();
  }

  function selectTitleFontSize(btn) {
    document.querySelectorAll('#titleFontSizePresets .font-size-btn').forEach(function (b) {
      b.classList.remove('selected');
    });
    btn.classList.add('selected');
    selectedTitleFontSize = btn.dataset.size;
    updateNotifPreview();
  }

  function updateNotifPreview() {
    const title = document.getElementById('notifTitleInput')?.value || 'Title Preview';
    const message = document.getElementById('notifMessageInput')?.value || 'Message preview will appear here...';
    const previewTitle = document.getElementById('previewTitle');
    const previewMessage = document.getElementById('previewMessage');
    const titleCount = document.getElementById('notifTitleCount');
    const messageCount = document.getElementById('notifMessageCount');

    if (previewTitle) {
      previewTitle.textContent = title || 'Title Preview';
      previewTitle.style.color = selectedTitleColor;
      let fontSize = '0.72rem';
      if (selectedTitleFontSize === 'small') fontSize = '0.64rem';
      else if (selectedTitleFontSize === 'large') fontSize = '0.82rem';
      previewTitle.style.fontSize = fontSize;
    }
    if (previewMessage) {
      previewMessage.textContent = message || 'Message preview will appear here...';
    }
    if (titleCount) {
      titleCount.textContent = (document.getElementById('notifTitleInput')?.value.length || 0) + '/100';
    }
    if (messageCount) {
      const messageLen = document.getElementById('notifMessageInput')?.value.length || 0;
      messageCount.textContent = messageLen + (messageLen === 1 ? ' char' : ' chars');
    }
    resizeMessageTextarea();
  }

  function closeNotificationModal() {
    const modal = document.getElementById('notificationRichModal');
    if (modal) modal.classList.remove('active');
    currentNotificationNewsItem = null;
  }

  function confirmSendNotification() {
    if (!currentNotificationNewsItem) return;

    const title = document.getElementById('notifTitleInput')?.value.trim();
    const message = document.getElementById('notifMessageInput')?.value.trim();

    if (!title || !message) {
      alert('Please enter both title and message');
      return;
    }

    const notificationData = {
      title: title,
      message: message,
      newsId: currentNotificationNewsItem._id,
      language: currentNotificationNewsItem.language || null,
      imageUrl: currentNotificationNewsItem.mediaUrl || currentNotificationNewsItem.imageUrl,
      launchUrl: null,
      platformSettings: {},
      priority: 'high',
      titleColor: selectedTitleColor,
      titleFontSize: selectedTitleFontSize
    };

    const sendBtn = document.getElementById('sendNotifBtn');
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
    }

    fetch('/admin/api/send-notification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notificationData)
    })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        closeNotificationModal();
        const langLabel = data.targetLanguage ? (' (' + data.targetLanguage + ' users only)') : '';
        alert('Notification sent successfully' + langLabel + '!');
      })
      .catch(function (error) {
        alert('Error: ' + error.message);
      })
      .finally(function () {
        if (sendBtn) {
          sendBtn.disabled = false;
          sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Send push';
        }
      });
  }

  document.addEventListener('click', function (e) {
    const modal = document.getElementById('notificationRichModal');
    if (e.target === modal) closeNotificationModal();
  });

  global.sendNotificationForNews = sendNotificationForNews;
  global.selectTitleColor = selectTitleColor;
  global.selectCustomTitleColor = selectCustomTitleColor;
  global.selectTitleFontSize = selectTitleFontSize;
  global.updateNotifPreview = updateNotifPreview;
  global.closeNotificationModal = closeNotificationModal;
  global.confirmSendNotification = confirmSendNotification;
})(typeof window !== 'undefined' ? window : global);
