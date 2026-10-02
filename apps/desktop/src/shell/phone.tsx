// The phone form's chrome: the drawer the sidebar becomes, the button in each
// screen's header that opens it, and the back button a screen shows in place
// of its sidebar. The App provides the drawer; screens only place the button.
// On a desktop form none of these render.

import { Btn } from "@monday/ui";
import { ArrowLeftIcon, ListIcon } from "@phosphor-icons/react";
import { createContext, type ReactNode, useContext } from "react";
import { useExit } from "../screens/inbox/useExit.ts";
import { useBack } from "./back.ts";
import { useShell } from "./Shell.tsx";

export interface PhoneNav {
  /** Opens the drawer with the sidebar. */
  openDrawer(): void;
}

export const PhoneNavContext = createContext<PhoneNav | null>(null);

/** The header's drawer button in the phone form; nothing on a desktop or without a drawer. */
export function DrawerButton() {
  const shell = useShell();
  const nav = useContext(PhoneNavContext);
  if (shell.form !== "phone" || !nav) return null;
  const label = shell.settings["strings.phone.menu"];
  return (
    <Btn icon className="phone-menu" aria-label={label} title={label} onClick={nav.openDrawer}>
      <ListIcon />
    </Btn>
  );
}

/** A back button for a page pushed over another in the phone form (a Settings page over the list). */
export function BackButton({ onBack }: { onBack: () => void }) {
  const shell = useShell();
  if (shell.form !== "phone") return null;
  const label = shell.settings["strings.phone.back"];
  return (
    <Btn icon className="phone-back" aria-label={label} title={label} onClick={onBack}>
      <ArrowLeftIcon />
    </Btn>
  );
}

/**
 * The sidebar as a drawer from the left, over a scrim. A tap on the scrim, a
 * pick inside it, back, or a swipe back closes it.
 */
export function PhoneDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const back = useShell().settings["strings.phone.back"];
  const exit = useExit(open);
  useBack(open, onClose);
  if (!exit.mounted) return null;
  return (
    <div className={`phone-drawer${exit.leaving ? " leaving" : ""}`} onAnimationEnd={exit.onEnd}>
      <button
        type="button"
        className="phone-scrim"
        aria-label={back}
        tabIndex={-1}
        onClick={onClose}
      />
      <div className="phone-drawer-in" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}
