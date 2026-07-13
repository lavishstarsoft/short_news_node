/** Sidebar menus that sub-editors must be explicitly granted (opt-in). */
const OPT_IN_SIDEBAR_MENUS = new Set(['zodiac']);

/**
 * Whether an admin user may access a dashboard sidebar page.
 * Sub-editors: most menus are on unless set false; opt-in menus need sidebar[menu] === true.
 */
function canAccessSidebarMenu(admin, menu) {
  if (!admin) return false;
  if (admin.role === 'admin' || admin.role === 'superadmin') return true;
  if (admin.role !== 'subeditor') return true;

  const sidebar = admin.permissions?.sidebar;
  if (!sidebar) {
    return OPT_IN_SIDEBAR_MENUS.has(menu) ? false : true;
  }

  if (OPT_IN_SIDEBAR_MENUS.has(menu)) {
    return sidebar[menu] === true;
  }

  return sidebar[menu] !== false;
}

module.exports = {
  OPT_IN_SIDEBAR_MENUS,
  canAccessSidebarMenu
};
