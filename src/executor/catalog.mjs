export const SUITES = Object.freeze([
  { id: "demo-form", title: "Formulario: completar email", description: "Completa el campo de email en una fixture local y comprueba su valor." },
  { id: "demo-controls", title: "Controles: checkbox y selección", description: "Cambia controles HTML en una fixture local y los verifica." },
  { id: "demo-failure", title: "Demo de fallo", description: "Falla intencionalmente una verificación para demostrar el reporte." },
]);

export function getSuite(id) { return SUITES.find(s => s.id === id) ?? null; }
