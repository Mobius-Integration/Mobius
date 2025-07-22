// Smooth scroll for anchor links
const links = document.querySelectorAll('a[href^="#"]');
links.forEach(link => link.addEventListener('click', evt => {
  const target = document.querySelector(evt.currentTarget.getAttribute('href'));
  if (target) { evt.preventDefault(); target.scrollIntoView({ behavior: 'smooth' }); }
}));

// Simple opt‑in form handler – client‑side demo only
document.getElementById('optin-form').addEventListener('submit', evt => {
  evt.preventDefault();
  const phone = evt.target.phone.value.trim();
  if (!phone) return;
  alert(`Thanks! We'll confirm WhatsApp consent for ${phone} shortly.`);
  evt.target.reset();
});

// Dynamic year in footer
document.getElementById('yr').textContent = new Date().getFullYear();
