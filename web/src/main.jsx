import React from "react";
import { createRoot } from "react-dom/client";
import GyoseiQuiz from "./GyoseiQuiz.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <GyoseiQuiz />
  </React.StrictMode>
);
