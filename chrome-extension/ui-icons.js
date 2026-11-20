const kittyPlaysIconPaths = {
  ai: "M8 2Q8 8 14 8Q8 8 8 14Q8 8 2 8Q8 8 8 2ZM18 10Q18 16 24 16Q18 16 18 22Q18 16 12 16Q18 16 18 10Z",
  flow: "M2 8L12 2L22 8L12 14ZM2 12L12 18L22 12M2 16L12 22L22 16",
  hybrid: "M14 8L9 16M16 8L19 15M16 8A3 3 0 1 0 16 2A3 3 0 0 0 16 8ZM7 22A3 3 0 1 0 7 16A3 3 0 0 0 7 22ZM20 21A3 3 0 1 0 20 15A3 3 0 0 0 20 21Z",
  fidelityfx: "M6 4H18Q20 4 20 6V18Q20 20 18 20H6Q4 20 4 18V6Q4 4 6 4ZM8 1V4M12 1V4M16 1V4M8 20V23M12 20V23M16 20V23M1 8H4M1 12H4M1 16H4M20 8H23M20 12H23M20 16H23M8 8H16V16H8Z",
  original: "M4 5H20Q22 5 22 7V17Q22 19 20 19H4Q2 19 2 17V7Q2 5 4 5ZM10 9L15 12L10 15Z",
  info: "M12 22A10 10 0 1 0 12 2A10 10 0 0 0 12 22ZM11 11H12V17M10 17H14M12 7H12.1",
  paw: "M12 12C9 12 8 15 5 17C2 21 7 24 11 21Q12 20 14 21C18 24 22 20 19 17C16 15 15 12 12 12ZM5 14C1 14 0 8 3 7C6 6 8 13 5 14ZM10 10C6 10 6 3 9 2C12 1 14 9 10 10ZM16 10C12 9 14 1 17 2C20 3 20 10 16 10ZM20 15C17 14 19 8 22 9C25 10 23 16 20 15Z",
  memory: "M2 7H22V17H2ZM6 11V13M10 11V13M14 11V13M18 11V13",
  screen: "M4 4H20Q22 4 22 6V15Q22 17 20 17H4Q2 17 2 15V6Q2 4 4 4ZM12 17V21M8 21H16",
  clock: "M12 22A10 10 0 1 0 12 2A10 10 0 0 0 12 22ZM12 6V12H16",
  warning: "M11 3Q12 1 13 3L22 19Q23 21 21 21H3Q1 21 2 19ZM12 8V14M12 17H12.1",
};

function kittyPlaysIcon(name) {
  const namespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(namespace, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("class", "kittyplays-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", kittyPlaysIconPaths[name]);
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  if (name === "paw" || name === "ai") {
    path.setAttribute("fill", "currentColor");
  } else {
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.7");
  }
  icon.append(path);
  return icon;
}
