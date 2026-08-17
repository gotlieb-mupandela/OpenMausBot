import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/** Mobile shell: bot list vs chat. Desktop ignores this — sidebar stays visible. */
const MD = "(min-width: 768px)";

type MobileNav = {
  listOpen: boolean;
  openList: () => void;
  closeList: () => void;
};

const MobileNavContext = createContext<MobileNav | null>(null);

export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(MD);
    const onChange = () => {
      if (mq.matches) setListOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const openList = useCallback(() => setListOpen(true), []);
  const closeList = useCallback(() => setListOpen(false), []);

  return (
    <MobileNavContext.Provider value={{ listOpen, openList, closeList }}>
      {children}
    </MobileNavContext.Provider>
  );
}

export function useMobileNav(): MobileNav {
  const ctx = useContext(MobileNavContext);
  if (!ctx) throw new Error("useMobileNav must be used within MobileNavProvider");
  return ctx;
}
