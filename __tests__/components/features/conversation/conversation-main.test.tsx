import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router";
import { SidebarMobileNavProvider } from "#/components/features/sidebar/sidebar-mobile-nav-context";

// Mutable mock state for controlling breakpoint
let mockIsMobile = false;
let mockIsRightPanelShown = false;
let mockLeftWidth = 50;

// Track ChatInterface unmount via vi.fn()
const chatInterfaceUnmount = vi.fn();

vi.mock("#/hooks/use-breakpoint", () => ({
  useBreakpoint: () => mockIsMobile,
  SIDEBAR_RAIL_COLLAPSE_MAX_WIDTH: 767,
}));

vi.mock("#/hooks/use-resizable-panels", () => ({
  useResizablePanels: () => ({
    leftWidth: mockLeftWidth,
    rightWidth: 100 - mockLeftWidth,
    isDragging: false,
    containerRef: { current: null },
    handleMouseDown: vi.fn(),
  }),
}));

vi.mock("#/stores/conversation-store", () => ({
  useConversationStore: () => ({
    isRightPanelShown: mockIsRightPanelShown,
    setIsRightPanelShown: vi.fn(),
    setHasRightPanelToggled: vi.fn(),
    setSelectedTab: vi.fn(),
    getState: () => ({ selectedTab: null }),
  }),
}));

vi.mock("#/hooks/use-conversation-id", () => ({
  useConversationId: () => ({ conversationId: "conv-1" }),
}));

vi.mock("#/hooks/use-is-archived-conversation", () => ({
  useIsArchivedConversation: () => false,
}));

// Mock ChatInterface with useEffect to track mount/unmount lifecycle
vi.mock("#/components/features/chat/chat-interface", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    ChatInterface: () => {
      React.useEffect(() => {
        return () => chatInterfaceUnmount();
      }, []);
      return <div data-testid="chat-interface" />;
    },
  };
});

vi.mock(
  "#/components/features/conversation/conversation-tabs/conversation-tab-content/conversation-tab-content",
  () => ({
    ConversationTabContent: () => <div data-testid="tab-content" />,
  }),
);

// ConversationMain now renders the conversation name and tabs inline as the
// pane headers; both reach into route/store state we don't set up here, so
// stub them out for layout-stability tests.
vi.mock(
  "#/components/features/conversation/conversation-name-with-status",
  () => ({
    ConversationNameWithStatus: () => (
      <div data-testid="conversation-name-with-status" />
    ),
  }),
);

vi.mock(
  "#/components/features/conversation/conversation-tabs/conversation-tabs",
  () => ({
    ConversationTabs: () => <div data-testid="conversation-tabs" />,
  }),
);

import { ConversationMain } from "#/components/features/conversation/conversation-main/conversation-main";

function renderConversationMain() {
  return render(
    <MemoryRouter>
      <SidebarMobileNavProvider>
        <ConversationMain />
      </SidebarMobileNavProvider>
    </MemoryRouter>,
  );
}

// Re-render wrapper used by the breakpoint-crossing tests so the router
// context is preserved across rerenders.
function rerenderConversationMain(rerender: (ui: React.ReactElement) => void) {
  rerender(
    <MemoryRouter>
      <SidebarMobileNavProvider>
        <ConversationMain />
      </SidebarMobileNavProvider>
    </MemoryRouter>,
  );
}

describe("ConversationMain - Layout Transition Stability", () => {
  beforeEach(() => {
    mockIsMobile = false;
    mockIsRightPanelShown = false;
    mockLeftWidth = 50;
    chatInterfaceUnmount.mockClear();
  });

  it("renders ChatInterface at desktop width", () => {
    mockIsMobile = false;
    renderConversationMain();
    expect(screen.getByTestId("chat-interface")).toBeInTheDocument();
  });

  it("renders ChatInterface at mobile width", () => {
    mockIsMobile = true;
    renderConversationMain();
    expect(screen.getByTestId("chat-interface")).toBeInTheDocument();
  });

  it("does not unmount ChatInterface when crossing from desktop to mobile", () => {
    mockIsMobile = false;
    const { rerender } = renderConversationMain();
    expect(chatInterfaceUnmount).not.toHaveBeenCalled();

    // Cross the breakpoint to mobile
    mockIsMobile = true;
    rerenderConversationMain(rerender);

    // ChatInterface must NOT have been unmounted and remounted
    expect(chatInterfaceUnmount).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-interface")).toBeInTheDocument();
  });

  it("does not unmount ChatInterface when crossing from mobile to desktop", () => {
    mockIsMobile = true;
    const { rerender } = renderConversationMain();
    expect(chatInterfaceUnmount).not.toHaveBeenCalled();

    // Cross the breakpoint to desktop
    mockIsMobile = false;
    rerenderConversationMain(rerender);

    // ChatInterface must NOT have been unmounted and remounted
    expect(chatInterfaceUnmount).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-interface")).toBeInTheDocument();
  });

  it("survives rapid back-and-forth resize without unmounting ChatInterface", () => {
    mockIsMobile = false;
    const { rerender } = renderConversationMain();

    // Simulate rapid resize back and forth across the breakpoint
    for (const mobile of [true, false, true, false, true]) {
      mockIsMobile = mobile;
      rerenderConversationMain(rerender);
    }

    expect(chatInterfaceUnmount).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-interface")).toBeInTheDocument();
  });
});
