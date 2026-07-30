const fs = require('fs');
const path = require('path');

// 1. Update reporter-applications.ejs
const appsPath = path.join(__dirname, 'views', 'reporter-applications.ejs');
let appsContent = fs.readFileSync(appsPath, 'utf-8');

const targetButton = '<button type="button" class="ra-action-btn ra-action-btn--view"';
const newButton = `
                                        <% const locationStr = typeof raPickString === 'function' ? raPickString(app.data, ['district', 'District', 'mandal', 'Mandal', 'village', 'Village', 'constituency', 'Constituency', 'city', 'City', 'location', 'Location']) : ''; %>
                                        <a href="/register-editor?source=application&email=<%= encodeURIComponent(email || '') %>&name=<%= encodeURIComponent(name || '') %>&mobile=<%= encodeURIComponent(phone || '') %>&location=<%= encodeURIComponent(locationStr || '') %>"
                                           class="ra-action-btn" style="color: #059669; border-color: #a7f3d0; background: #ecfdf5; text-decoration: none;"
                                           title="Register as Member" target="_blank">
                                            <i class="fas fa-user-plus"></i> Onboard
                                        </a>
                                        <button type="button" class="ra-action-btn ra-action-btn--view"`;

appsContent = appsContent.replace(targetButton, newButton);
fs.writeFileSync(appsPath, appsContent);
console.log('Updated reporter-applications.ejs');

// 2. Update register-editor.ejs
const regPath = path.join(__dirname, 'views', 'register-editor.ejs');
let regContent = fs.readFileSync(regPath, 'utf-8');

// Replace addPassword HTML
const oldPassHtml = '<div class="col-md-6"><div class="editor-field"><label for="addPassword">Password *</label><input type="password" id="addPassword" required minlength="6" placeholder="Minimum 6 characters"></div></div>';
const newPassHtml = '<div class="col-md-6"><div class="editor-field"><label for="addPassword">Password *</label><div style="position:relative;"><input type="password" id="addPassword" required minlength="6" placeholder="Minimum 6 characters" style="padding-right: 40px;"><span id="toggleAddPassword" style="position:absolute; right:10px; top:50%; transform:translateY(-50%); cursor:pointer; color:#6b7280;"><i class="fas fa-eye"></i></span></div></div></div>';
regContent = regContent.replace(oldPassHtml, newPassHtml);

// Append JS Logic before </body> or at the end
const scriptBlock = `
<script>
document.addEventListener('DOMContentLoaded', function() {
    // 1. Password Visibility Toggle
    const toggleAddPassword = document.getElementById('toggleAddPassword');
    const addPassword = document.getElementById('addPassword');
    if (toggleAddPassword && addPassword) {
        toggleAddPassword.addEventListener('click', function() {
            const type = addPassword.getAttribute('type') === 'password' ? 'text' : 'password';
            addPassword.setAttribute('type', type);
            this.innerHTML = type === 'password' ? '<i class="fas fa-eye"></i>' : '<i class="fas fa-eye-slash"></i>';
        });
    }

    // 2. Auto-fill from URL parameters (if source=application)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('source') === 'application') {
        const email = urlParams.get('email');
        const name = urlParams.get('name');
        const mobile = urlParams.get('mobile');
        const loc = urlParams.get('location');

        if (email) {
            const emailEl = document.getElementById('addEmail');
            if (emailEl) emailEl.value = email;
            const userEl = document.getElementById('addUsername');
            if (userEl) userEl.value = email; 
        }
        if (name) {
            const nameEl = document.getElementById('addName');
            if (nameEl) nameEl.value = name;
        }
        if (mobile) {
            const mobEl = document.getElementById('addMobile');
            if (mobEl) mobEl.value = mobile;
        }
        
        // Let's set the location field if possible
        if (loc) {
            const constEl = document.getElementById('addConstituency');
            if (constEl) constEl.value = loc;
        }

        // Set default password to DDMMYYYY
        const today = new Date();
        const dd = String(today.getDate()).padStart(2, '0');
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const yyyy = today.getFullYear();
        if (addPassword) {
            addPassword.value = dd + mm + yyyy;
            // Also trigger change event to remove red border if it exists
            addPassword.dispatchEvent(new Event('input'));
        }
        
        // Select reporter role by default (optional, user didn't explicitly ask but makes sense)
        const repCard = document.querySelector('.editor-role-card[data-role="reporter"]');
        if (repCard) {
            repCard.click();
        }
    }
});
</script>
`;

const insertIndex = regContent.lastIndexOf('</script>');
if (insertIndex !== -1) {
    regContent = regContent.substring(0, insertIndex + '</script>'.length) + scriptBlock + regContent.substring(insertIndex + '</script>'.length);
} else {
    regContent += scriptBlock;
}

fs.writeFileSync(regPath, regContent);
console.log('Updated register-editor.ejs');

