import { emails } from "../data.js";
import { messageList, reader, agentDock } from "../components.js";
import { state } from "../theme.js";

export function render(route, ui) {
  const selected = emails.find(e => e.id === ui.selected);
  const stream = state.layout === "stream";
  const showReader = stream ? (ui.readerOpen && selected) : true;
  return `
  <div class="main inbox ${stream && showReader ? "has-sheet" : ""}">
    ${messageList(route, ui)}
    ${showReader ? reader(selected, { sheet: stream }) : ""}
    ${state.layout !== "agent-left" ? agentDock(ui) : ""}
  </div>`;
}
