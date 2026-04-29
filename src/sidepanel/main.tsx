import { render } from "preact";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("#app mount missing");
render(<App />, root);
