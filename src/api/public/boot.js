try {
  var saved = localStorage.getItem("mail_theme") || localStorage.getItem("flytrap_theme");
  if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
} catch (e) {}
