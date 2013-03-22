// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Cinnamon = imports.gi.Cinnamon;
const Signals = imports.signals;
const St = imports.gi.St;

const Applet = imports.ui.applet;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const PopupMenu = imports.ui.popupMenu;
const Tweener = imports.ui.tweener;

const PointerTracker = imports.misc.pointerTracker;
const Util = imports.misc.util;
const WindowUtils = imports.misc.windowUtils;

var Settings = null;
try {
    Settings = imports.ui.settings; // requires Cinnamon 1.7.2 or later
}
catch (e) {}

/* usage:
 * "let connection = connect(someObject, 'some-signal', someFunction [, ...])
 *  ///...
 *  connection.disconnect();
 *  "
 * 
 * @arg-0: target, the object you want to connect to
 * @arg-1 .. @arg-n: arguments to the target's connect function
 *
 * return value: an object that you call disconnect on
 */
var connect = function() {
    let args = [].slice.apply(arguments);
    let target = args.shift();
    let id = target.connect.apply(target, args);
    return {
        disconnect: function() {
            if (target) {
                target.disconnect(id); target = null;
                }
        },
        forget: function() {
            target = null;
        },
        getTarget: function() {
            return target;
        },
        /* Ties the connection to an object, so it is automatically destroyed with the object.
         */
        tie: function(object) {
            object.connect('destroy', Lang.bind(this, this.disconnect));
        }
    };
};

function Connector() {
    this._init.apply(this, arguments);
}

/* A class that takes care of your connections - just remember to
 * call destroy when it is time to disconnect.
 */
Connector.prototype = {
    _init: function() {
        this.connections = [];
    },

    /* usage: "addConnection(someObject, 'some-signal', someFunction [, ...])"
     * 
     * @arg-0: target, the object you want to connect to
     * @arg-1 .. @arg-n: arguments to the target's connect function
     *
     * @return aConnection, the created connection, which you can optionally disconnect or "forget" later on.
     */
    addConnection: function() {
        let connection = connect.apply(0, arguments);
        this.connections.push(connection);
        return connection;
    },

    /* Disconnects all connections.
     */
    destroy: function() {
        if (this.connections) {
            this.connections.forEach(function(connection) {
                connection.disconnect();
            }, this);
            this.connections = null;
        }
    },

    /* Ties the connector to an object, so the connector is automatically destroyed with the object.
     */
    tie: function(object) {
        object.connect('destroy', Lang.bind(this, this.destroy));
    }
};

const POPUP_APPICON_SIZE = 96;
const POPUP_SCROLL_TIME = 0.10; // seconds
const POPUP_DELAY_TIMEOUT = 110; // milliseconds

const APP_ICON_HOVER_TIMEOUT = 200; // milliseconds

const THUMBNAIL_FADE_TIME = 0.1; // seconds

const PREVIEW_DELAY_TIMEOUT = 180; // milliseconds
var PREVIEW_SWITCHER_FADEOUT_TIME = 0.5; // seconds

const DEMANDS_ATTENTION_CLASS_NAME = "window-list-item-demands-attention";

const iconSizes = [80, 72, 64, 56, 48, 40, 32, 24];

const HELP_TEXT = [
    "",
    _("Escape: Close Alt-Tab and return to the currently active window"),
    _("Return: Activate the currently selected window and close Alt-Tab"),
    _("Tab, Right arrow: Select next right"),
    _("Shift+Tab, Left arrow: Select next left"),
    _("Home: Select first window"),
    _("End: Select last window"),
    _("Ctrl+Right arrow: Skip right"),
    _("Ctrl+Left arrow: Skip left"),
    _("Ctrl+Space: Enter \"persistent mode\", in which Alt-Tab will remain open until actively closed"),
    _("m: Move selected window to next monitor"),
    _("n: Minimize selected window"),
    _("Ctrl+w: Close selected window. Use with care!"),
    _("Ctrl+g: Toggle \"global mode\", in which windows from all workspaces are mixed, sorted on last use"),
    _("z: Zoom to see all windows at once without scrolling (toggle)"),
    _("F4: Switch between the most common Alt-Tab styles"),
    _("F5: Toggle between seeing all windows or only windows from the current workspace"),
    _("F6: Change vertical alignment of switcher bar (top->center->bottom)"),
    _("F7: Toggle display of thumbnail header (showing window icon and title)"),
    _("F8: Toggle single-line window-title labels on/off"),
    _("F9: Switch between the different thumbnail-behind-icon styles (always, never, behind-identical-icons)"),
    _("F1: Show this quick-help screen"),
    "",
];

const KeyState = {
    PRESSED: 1,
    RELEASED: 2
};

function mod(a, b) {
    return (a + b) % b;
}

function primaryModifier(mask) {
    if (mask == 0)
        return 0;

    let primary = 1;
    while (mask > 1) {
        mask >>= 1;
        primary <<= 1;
    }
    return primary;
}

let g_monitorOverride = null;
let g_vAlignOverride = null;
function getVerticalAlignment() {
    return g_vAlignOverride || g_settings.vAlign;
}

var g_uuid;
function openSettings() {
    Util.spawnCommandLine("cinnamon-settings applets " + g_uuid);
}

var g_setup = {};
function processSwitcherStyle() {
    g_setup._previewEnabled = false;
    g_setup._iconsEnabled = false;
    g_setup._thumbnailsEnabled = false;
    g_setup._previewThumbnails = false;

    let styleSettingsMaster = g_settings.style;
    let isSystemStyle = styleSettingsMaster == ":system";
    let styleSettings = isSystemStyle ? g_vars.switcherStyle : styleSettingsMaster;

    let found = false;
    if (styleSettings.indexOf(":") < 0) {
        let features = styleSettings.split('+');
        for (let i in features) {
            if (features[i] === 'icons') {
                g_setup._iconsEnabled = true;
                found = true;
            }
            if (features[i] === 'preview') {
                g_setup._previewEnabled = true;
                found = true;
            }
            if (features[i] === 'thumbnails') {
                g_setup._thumbnailsEnabled = true;
                g_settings.vAlign = 'center';
                found = true;
            }
        }
    }
    else {
        if (styleSettings == ":dock") {
            g_setup._iconsEnabled = true;
            g_setup._thumbnailsEnabled = true;
            if (g_settings.vAlign == 'center') {
                g_settings.vAlign = 'bottom';
            }
        }
        if (styleSettings == ":preview-thumbnails") {
            g_setup._iconsEnabled = true;
            g_setup._previewEnabled = true;
            g_setup._previewThumbnails = true;
        }
    }
    if (!found) {
        g_setup._iconsEnabled = true;
    }

    g_setup._showThumbnails = g_setup._thumbnailsEnabled;
    if (g_vars.switcherStyleUpdated && isSystemStyle) {
        if (!g_setup._thumbnailsEnabled) {
            g_settings.vAlign = 'center';
        }
        g_vars.switcherStyleUpdated = false;
    }
}

const g_aligmentTypes = ["top", "center", "bottom"];
const g_alttabStyles = ["icons+preview", ":preview-thumbnails", "icons", "icons+thumbnails", ":dock"]; // the most usual ones ...
const g_thumbnailIconOptions = ["behind-identical", "always", "never"];

function getSwitcherStyle() {
    let oldstyle = g_settings["last-gsettings-switcher-style"];
    g_vars.switcherStyle = global.settings.get_string("alttab-switcher-style");
    g_vars.switcherStyleUpdated = oldstyle != g_vars.switcherStyle;
    if (g_vars.switcherStyleUpdated) {
        g_settings["last-gsettings-switcher-style"] = g_vars.switcherStyle;
    }
    processSwitcherStyle();
};

var g_vars = Main._alttab_enhanced_vars;
if (!g_vars) {
    g_vars = Main._alttab_enhanced_vars = {};
// there are some things we want to live on, even when we are disabled,
// so that we don't have to start from scratch if we are enabled again
    g_vars.windowsOrdered = [];
    g_vars.windowsToIgnore = [];
    g_vars.globalFocusOrder = false;

    connect(global.display, 'notify::focus-window', function(display) {
        g_vars.windowsOrdered = g_vars.windowsOrdered.filter(function(window) {
            return window && window != display.focus_window && window.get_workspace();
        }, this);
        g_vars.windowsOrdered.unshift(display.focus_window);
    });
    connect(global.settings, 'changed::alttab-switcher-style', getSwitcherStyle);

    // this object will be populated with our settings, if settings support is available
    g_vars.settings = {};
}

const g_settings = g_vars.settings;

var g_myMonitor = Main.layoutManager.primaryMonitor;
var g_myMonitorIndex = Main.layoutManager.primaryIndex;

function createApplicationIcon(app, size) {
    return app ?
        app.create_icon_texture(size) :
        new St.Icon({ icon_name: 'application-default-icon',
            icon_type: St.IconType.FULLCOLOR,
            icon_size: size
        });
}

function getTabList(workspaceOpt, screenOpt) {
    let screen = screenOpt || global.screen;
    let display = screen.get_display();
    let workspace = workspaceOpt || screen.get_active_workspace();

    let allwindows = display.get_tab_list(Meta.TabList.NORMAL_ALL, screen,
                                       workspace);
    if (allwindows.length) {
        return allwindows.filter(Main.isInteresting);
    }
    return [];
}

function AltTabPopup() {
    this._init();
}

AltTabPopup.prototype = {
    _init : function() {
        if (!g_monitorOverride) {
            let mIndex;
            switch (g_settings.preferredMonitor) {
                case ":primary":
                    mIndex = "primaryMonitor"; break;
                case ":top":
                    mIndex = "topMonitor"; break;
                case ":bottom":
                    mIndex = "bottomMonitor"; break;
                case ":focus":
                    mIndex = "focusMonitor"; break;
                default:
                    mIndex = "primaryMonitor"; break;
            }
            g_myMonitorIndex = Main.layoutManager.monitors.indexOf(Main.layoutManager[mIndex]);
        } else {
            g_myMonitorIndex = Main.layoutManager.monitors.indexOf(g_monitorOverride);
        }
        g_myMonitorIndex = g_myMonitorIndex >= 0 ? g_myMonitorIndex : 0;
        g_myMonitor = Main.layoutManager.monitors[g_myMonitorIndex];

        this._loadTs = (new Date()).getTime();
        this.actor = new Cinnamon.GenericContainer({ name: 'altTabPopup',
                                                  reactive: true,
                                                  visible: false });

        this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this.actor.connect('allocate', Lang.bind(this, this._allocate));

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        this._haveModal = false;
        this._modifierMask = 0;

        // Keeps track of the number of "primary" items, which is the number
        // of windows on the current workspace. This information is used to
        // size the icons to a size that fits the current working set.
        this._numPrimaryItems = 0;

        this.thumbnailsVisible = false;

        let connector = new Connector();
        connector.tie(this.actor);

        let connectToWorkspace = Lang.bind(this, function(workspace) {
            connector.addConnection(workspace, 'window-removed', Lang.bind(this, function(ws, metaWindow) {
                this._removeWindow(metaWindow);
            }));
            connector.addConnection(workspace, 'window-added', Lang.bind(this, function(ws, metaWindow) {
                Mainloop.idle_add(Lang.bind(this, function() {
                    this.refresh();
                }));
            }));
        });
        for (let [i, numws] = [0, global.screen.n_workspaces]; i < numws; ++i) {
            let workspace = global.screen.get_workspace_by_index(i);
            connectToWorkspace(workspace);
        }
        connector.addConnection(global.display, 'window-demands-attention', Lang.bind(this, this._onWindowDemandsAttention));
        connector.addConnection(global.display, 'window-marked-urgent', Lang.bind(this, this._onWindowDemandsAttention));
        connector.addConnection(global.screen, 'workspace-added', Lang.bind(this, function(screen, index) {
            let workspace = global.screen.get_workspace_by_index(index);
            connectToWorkspace(workspace);
        }));

        // remove zombies
        if (g_vars.windowsToIgnore.length) {
            g_vars.windowsToIgnore = g_vars.windowsToIgnore.filter(function(window) {
                return window.get_workspace() != null;
            });
        }

        Main.uiGroup.add_actor(this.actor);
    },

    _indexOfWindow: function(metaWindow) {
        let index = -1;
        if (!this._appSwitcher || !this._appIcons) {
            return index;
        }
        this._appIcons.some(function(ai, ix) {
            if (ai.window == metaWindow) {
                index = ix;
                return true; // break
            }
            return false; // continue
        }, this);
        return index;
    },

    _removeWindow: function(metaWindow) {
        let index = this._indexOfWindow(metaWindow);
        if (index >= 0) {
            if (index == this._currentApp) {
                this._clearPreview();
                this._destroyThumbnails();
            }
            if (metaWindow == this._homeWindow) {
                this._homeWindow = null;
            }
            this._appSwitcher._removeIcon(index);
            this._select(this._currentApp, true);
            this.refresh();
        }
    },

    _onWindowDemandsAttention: function(display, metaWindow) {
        let index = this._indexOfWindow(metaWindow);
        if (index >= 0) {
            this._appIcons[index]._checkAttention();
        }
    },

    _getPreferredWidth: function (actor, forHeight, alloc) {
        alloc.min_size = global.screen_width;
        alloc.natural_size = global.screen_width;
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        alloc.min_size = global.screen_height;
        alloc.natural_size = global.screen_height;
    },

    _allocate: function (actor, box, flags) {
        let childBox = new Clutter.ActorBox();
        let primary = g_myMonitor;

        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);
        let bottomPadding = this.actor.get_theme_node().get_padding(St.Side.BOTTOM);
        let vPadding = this.actor.get_theme_node().get_vertical_padding();
        let hPadding = leftPadding + rightPadding;

        // Allocate the appSwitcher
        // We select a size based on an icon size that does not overflow the screen
        let [childMinHeight, childNaturalHeight] = this._appSwitcher.actor.get_preferred_height(primary.width - hPadding);
        let [childMinWidth, childNaturalWidth] = this._appSwitcher.actor.get_preferred_width(childNaturalHeight);
        childNaturalWidth = Math.max(childNaturalWidth, primary.width/8);
        childBox.x1 = Math.max(primary.x + leftPadding, primary.x + Math.floor((primary.width - childNaturalWidth) / 2));
        childBox.x2 = Math.min(primary.x + primary.width - rightPadding, childBox.x1 + childNaturalWidth);
        let vAlignment = getVerticalAlignment();
        childBox.y1 = primary.y + Math.floor(
            vAlignment == 'center'
                ? (primary.height - childNaturalHeight) / 2
                : vAlignment == 'top'
                    ? 0
                    : primary.height - childNaturalHeight);
        childBox.y2 = childBox.y1 + childNaturalHeight;
        this._appSwitcher.actor.allocate(childBox, flags);

        // Allocate the thumbnails
        // We try to avoid overflowing the screen so we base the resulting size on
        // those calculations
        if (this._thumbnails && this._currentApp >= 0) {
            let icon = this._appIcons[this._currentApp].actor;
            let [posX, posY] = icon.get_transformed_position();
            let thumbnailCenter = posX + icon.width / 2;
            let spacing = this.actor.get_theme_node().get_length('spacing');
            let spacing2 = Math.floor(spacing/2);
            let thHeight = vAlignment == 'center'
                ? primary.height - (this._appSwitcher.actor.allocation.y2 - primary.y) - spacing
                : primary.height - (this._appSwitcher.actor.allocation.y2 - this._appSwitcher.actor.allocation.y1) - spacing
                ;
            let thWidth = Math.floor(thHeight * primary.width / primary.height) + leftPadding * 2;

            childBox.x1 = primary.x + Math.floor((primary.width - thWidth)/2);
            childBox.x2 = childBox.x1 +  thWidth;
            childBox.y1 = vAlignment == 'bottom'
                ? this._appSwitcher.actor.allocation.y1 - thHeight - spacing2
                : this._appSwitcher.actor.allocation.y2 + spacing2
                ;
            childBox.y2 = childBox.y1 + thHeight;
            this._thumbnails.actor.allocate(childBox, flags);
        }
    },

    set _currentApp(val) {
        this._appSwitcher._curApp = val;
    },

    get _currentApp() {
        return this._appSwitcher._curApp;
    },

    get _appIcons() {
        return this._appSwitcher.icons;
    },

    refresh : function(binding, backward) {
        if (this._appSwitcher) {
            this._destroyThumbnails();
            this._appSwitcher.actor.destroy();
        }
       
        // Find out the currently active window
        let wsWindows = getTabList();
        let [currentWindow, forwardWindow, backwardWindow] = [(wsWindows.length > 0 ? wsWindows[0] : null), null, null];

        let windows = [];
        let [currentIndex, forwardIndex, backwardIndex] = [-1, -1, -1];
        let registry = {};

        let activeWsIndex = global.screen.get_active_workspace_index();
        for (let [i, numws] = [0, global.screen.n_workspaces]; i < numws; ++i) {
            let wlist = i == activeWsIndex ? wsWindows : getTabList(global.screen.get_workspace_by_index(i));
            if (!wlist.length) {
                continue;
            }
            wlist = wlist.filter(function(window) {
                let seqno = window.get_stable_sequence();
                if (registry[seqno]) {
                    return false;
                }
                registry[seqno] = true;
                return true;
            }, this);

            if (i != activeWsIndex) {
                wlist = wlist.filter(function(window) {
                    // We don't want duplicates. Ignored windows from other workspaces are not welcome.
                    return !window.is_on_all_workspaces() && (!g_vars.globalFocusOrder || g_vars.windowsToIgnore.indexOf(window) < 0);
                }, this);
            }
            if (g_settings.allWorkspacesMode || i == activeWsIndex) {
                windows = windows.concat(wlist);
            }
            if (i == activeWsIndex) {
                currentIndex = windows.indexOf(currentWindow);
                // Quick alt-tabbing (with no use of the switcher) should only
                // select between the windows of the active workspace.
                forwardWindow = windows[wlist.length > 1 ? currentIndex + 1 : currentIndex];
                backwardWindow = windows[wlist.length > 1 ? currentIndex + wlist.length - 1 : currentIndex];
            }
        }

        if (g_vars.globalFocusOrder) {
            windows = windows.sort(function(a, b) {
                let minimizedDiff = (a.minimized ? 1 : 0) - (b.minimized ? 1 : 0);
                if (minimizedDiff) {
                    return minimizedDiff;
                }
                let ignoredDiff = (g_vars.windowsToIgnore.indexOf(a) < 0 ? 0 : 1) - (g_vars.windowsToIgnore.indexOf(b) < 0 ? 0 : 1);
                if (ignoredDiff) {
                    return ignoredDiff;
                }
                let inGlobalListDiff = (g_vars.windowsOrdered.indexOf(a) < 0 ? 1 : 0) - (g_vars.windowsOrdered.indexOf(b) < 0 ? 1 : 0);
                if (inGlobalListDiff) {
                    return inGlobalListDiff;
                }
                let globalDiff = g_vars.windowsOrdered.indexOf(a) - g_vars.windowsOrdered.indexOf(b);
                return globalDiff || windows.indexOf(a) - windows.indexOf(b);
            }, this);
            currentWindow = windows[0];
            forwardWindow = windows[1];
            backwardWindow = windows[windows.length - 1];
        }

        currentIndex = windows.indexOf(currentWindow);
        if (forwardWindow) {forwardIndex = windows.indexOf(forwardWindow)};
        if (backwardWindow) {backwardIndex = windows.indexOf(backwardWindow)};

        // Size the icon bar primarily to fit the windows of the current workspace, and a few more
        this._numPrimaryItems_Orig = Math.min(Math.max(2, wsWindows.length + 4), windows.length);
        this._numPrimaryItems = g_settings.zoom ? this._numPrimaryItems_Orig : windows.length;
        this._zoomedOut = this._numPrimaryItems != this._numPrimaryItems_Orig;

        this._createAppswitcher(windows);
        
        this._appSwitcher.actor.opacity = this._persistent ? 255 : 0;
        this.actor.show();
        
        if (!this._homeWindow) {
            this._homeWindow = currentWindow;
        }

        // if we are refreshing after already being shown, retain current selection, if possible
        if (this._selectedWindow) {
            forwardIndex = windows.indexOf(this._selectedWindow);
        }


        // Make the initial selection
        if (this._appIcons.length > 0 && currentIndex >= 0) {
            if (binding == 'no-switch-windows') {
                this._select(currentIndex);
                this._appSwitcher._scrollTo(backwardIndex, 1, 3, true);
                this._appSwitcher._scrollTo(currentIndex, -1, 2, true);
            } else if (backward) {
                this._select(backwardIndex);
                this._appSwitcher._scrollTo(backwardIndex, 1, 0, true);
            } else {
                if (forwardIndex >= 0) {
                    this._select(forwardIndex);
                    // ensure that all the windows of the current workspace are in view
                    this._appSwitcher._scrollTo(backwardIndex, 1, 3, true);
                    this._appSwitcher._scrollTo(forwardIndex, -1, 2, true);
                }
            }
        } else {
            this._clearPreview();
        }
        // There's a race condition; if the user released Alt before
        // we got the grab, then we won't be notified. (See
        // https://bugzilla.gnome.org/show_bug.cgi?id=596695 for
        // details.) So we check now. (Have to do this after updating
        // selection.)
        if (!this._persistent) {
            let [x, y, mods] = global.get_pointer();
            if (!(mods & this._modifierMask)) {
                return false;
            }
        }

        if (this._appSwitcher.actor.opacity != 255) {
            // We delay showing the popup so that fast Alt+Tab users aren't
            // disturbed by the popup briefly flashing.
            let timeout = POPUP_DELAY_TIMEOUT - ((new Date().getTime()) - this._loadTs);
            if (timeout > 25) {
                this._initialDelayTimeoutId = Mainloop.timeout_add(Math.max(0, timeout),
                    Lang.bind(this, function () {
                        this._appSwitcher.actor.opacity = 255;
                        this._initialDelayTimeoutId = 0;
                    }));
            }
            else {
                this._appSwitcher.actor.opacity = 255;
            }
        }
        
        if (g_settings.allWorkspacesMode && g_settings.displayOriginArrow && !g_vars.globalFocusOrder) { // restricted feature
            this._appSwitcher._indicateItem(currentIndex, "_currentFocus", St.Side.TOP);
        }
        return true;
    },

    _showWindowContextMenu: function(appIcon) {
        this._persistent = true;
        let mm = new PopupMenu.PopupMenuManager(this);
        let orientation = getVerticalAlignment() == 'top' ? St.Side.TOP : St.Side.BOTTOM;
        let menu = new Applet.AppletPopupMenu({actor: appIcon.actor}, orientation)
        mm.addMenu(menu);

        let mw = appIcon.window;
        let items = [];

        let itemCloseWindow = new PopupMenu.PopupMenuItem(_("Close window"));
        itemCloseWindow.connect('activate', Lang.bind(this, function(actor, event){
            mw.delete(global.get_current_time());
        }));
        items.push(itemCloseWindow);

        let itemMinimizeWindow = new PopupMenu.PopupMenuItem(mw.minimized ? _("Restore") : _("Minimize"));
        itemMinimizeWindow.connect('activate', Lang.bind(this, function(actor, event){
            mw.minimized ? mw.unminimize() : mw.minimize();
            this._select(this._currentApp, true); // refresh
        }));
        items.push(itemMinimizeWindow);

        if (Main.layoutManager.monitors.length > 1) {
            let monitorItems = [];
            let submenu = new PopupMenu.PopupSubMenuMenuItem(_("Monitors"));
            Main.layoutManager.monitors.forEach(function(monitor, index) {
                if (index !== mw.get_monitor()) {
                    let item = new PopupMenu.PopupMenuItem(
                        _("Move to monitor %d").format(index + 1));
                    item.connect('activate', Lang.bind(this, function() {
                        mw.move_to_monitor(index);
                        this._select(this._currentApp, true); // refresh
                    }));
                    if (Main.layoutManager.monitors.length > 2) {
                        submenu.menu.addMenuItem(item);
                    } else {
                        monitorItems.push(item);
                    }
                }
            }, this);
            if (!monitorItems.length) {
                monitorItems.push(submenu);
            }
            monitorItems.push(new PopupMenu.PopupSeparatorMenuItem());
            items = monitorItems.concat(items);
        }

        if (true) {
            let wsItems = [];
            let submenu = new PopupMenu.PopupSubMenuMenuItem(_("Workspaces"));
            let submenuCount = 0;
            for (let i = 0; i < global.screen.n_workspaces; ++i) {
                if (i != mw.get_workspace().index()) {
                    let item = new PopupMenu.PopupMenuItem(
                        _("Move to workspace %d").format(i + 1));
                    let index = i;
                    item.connect('activate', Lang.bind(this, function() {
                        mw.change_workspace(global.screen.get_workspace_by_index(index));
                    }));
                    if (global.screen.n_workspaces > 2) {
                        submenu.menu.addMenuItem(item);
                        ++submenuCount;
                    } else {
                        wsItems.push(item);
                    }
                }
            }
            let itemMoveToNewWorkspace = new PopupMenu.PopupMenuItem(_("Move to a new, temporary workspace"));
            itemMoveToNewWorkspace.connect('activate', Lang.bind(this, function(actor, event) {
                let lastWsIndex = global.screen.n_workspaces - 1;
                Main.moveWindowToNewWorkspace(mw, false);
                let lastWsIndexNew = global.screen.n_workspaces - 1;
                if (lastWsIndexNew > lastWsIndex) {
                    let ws = global.screen.get_workspace_by_index(lastWsIndexNew);
                    ws.connect('window-removed', function() {
                        if (!getTabList(ws).filter(function(window) {
                            return !window.is_on_all_workspaces();
                        }, this).length) {
                            Main._removeWorkspace(ws);
                        }
                    });
                }
            }));
            if (submenuCount) {
                submenu.menu.addMenuItem(itemMoveToNewWorkspace);
                wsItems.push(submenu);
            } else {
                wsItems.push(itemMoveToNewWorkspace);
            }
            wsItems.push(new PopupMenu.PopupSeparatorMenuItem());
            items = wsItems.concat(items);
        };

        items.forEach(function(item) {
            menu.addMenuItem(item);
        }, this);

        menu.connect('open-state-changed', Lang.bind(this, function(sender, opened) {
            this._menuActive = opened;
            if (!opened) {
                if (this.actor) {
                    global.stage.set_key_focus(this.actor);
                }
            }
        }));
        menu.open();
    },

    _createAppswitcher: function(windows) {
        if (this._appSwitcher) {
            this._appSwitcher.actor.destroy();
        }
        this._appSwitcher = new AppSwitcher(windows, g_setup._showThumbnails, g_setup._iconsEnabled, this);
        this.actor.add_actor(this._appSwitcher.actor);
        if (!g_setup._iconsEnabled && !g_setup._thumbnailsEnabled) {
            this._appSwitcher.actor.hide();
        }
        this._appSwitcher.connect('item-activated', Lang.bind(this, this._appActivated));
        this._appSwitcher.connect('item-context-menu', Lang.bind(this, function(sender, n) {
            this._select(n, false);
            this._showWindowContextMenu(this._appIcons[n]);
        }));
        this._appSwitcher.connect('hover', Lang.bind(this, function(sender, index) {
            this._appSwitcher._noscroll = true;
            try {
                this._select(index);
            }
            finally {
                this._appSwitcher._noscroll = false;
            }
        }));
    },
    
    show : function(backward, binding, mask) {
        if (!Main.pushModal(this.actor)) {
            this.destroy();
            return false;
        }
        this._haveModal = true;
        this._modifierMask = primaryModifier(mask);
        if (binding && binding.search(/group/) >= 0) {
            g_settings.allWorkspacesMode = false;
        }
        if (!this.refresh(binding, backward)) {
            this._finish();
            return false;
        }
        
        this.actor.connect('key-press-event', Lang.bind(this, this._keyPressReleaseEvent, KeyState.PRESSED));
        this.actor.connect('key-release-event', Lang.bind(this, this._keyPressReleaseEvent, KeyState.RELEASED));

        this.actor.connect('button-release-event', Lang.bind(this, this._clickedOutside));
        this.actor.connect('scroll-event', Lang.bind(this, this._onScroll));
        return true;
    },

    _nextApp : function(nowrap) {
        return nowrap
            ? Math.min(this._currentApp + 1, this._appIcons.length - 1)
            : mod(this._currentApp + 1, this._appIcons.length);
    },
    _previousApp : function(nowrap) {
        return nowrap
            ? Math.max(this._currentApp - 1, 0)
            : mod(this._currentApp - 1, this._appIcons.length);
    },

    _toggleZoom : function() {
        this._zoomedOut = !this._zoomedOut;
        let numItems = this._zoomedOut ? this._appIcons.length : this._numPrimaryItems_Orig;
        if (numItems != this._numPrimaryItems) {
            this._numPrimaryItems = numItems;
            let current = this._currentApp; // save before re-creating the app switcher
            let windows = this._appIcons.map(function(appIcon) {return appIcon.window;});
            this._createAppswitcher(windows);
            if (current >= 0) {
                Mainloop.idle_add(Lang.bind(this, this._select, current)); // async refresh
            }
        }
    },

    _keyPressReleaseEvent : function(actor, event, keyState) {
        let released = keyState === KeyState.RELEASED;
        let pressed = keyState === KeyState.PRESSED;

        if (released) {
            let [x, y, mods] = global.get_pointer();
            let state = mods & this._modifierMask;

            if (state == 0 && !this._persistent) {
                this._finish();
                return true;
            }
        }
        
        let findFirstWorkspaceWindow = Lang.bind(this, function(startIndex) {
            let wsCurIx = this._appIcons[startIndex].window.get_workspace().index();
            for (let i = startIndex; i >= 0; --i) {
                if (this._appIcons[i].window.get_workspace().index() == wsCurIx) {
                    continue;
                }
                return i + 1;
             }
            return 0;
        });

        let skipWorkspace = Lang.bind(this, function(direction) {
            if (this._currentApp < 0) {
                return false;
            }
            let wsCurIx = this._appIcons[this._currentApp].window.get_workspace().index();
            if (direction > 0) {
                for (let [i, iLen] = [this._currentApp + 1, this._appIcons.length]; i < iLen; ++i) {
                    if (i == iLen - 1 || this._appIcons[i].window.get_workspace().index() != wsCurIx) {
                        this._select(i);
                        return true;
                    }
                }
            }
            if (direction < 0) {
                let ix = findFirstWorkspaceWindow(this._currentApp);
                if (ix == 0 || this._currentApp - ix > 0) {
                    this._select(ix);
                    return true;
                }
                this._select(findFirstWorkspaceWindow(ix - 1));
                return true;
            }
            return false;
        });

        let switchWorkspace = Lang.bind(this, function(direction) {
            if (g_settings.allWorkspacesMode) {
                return skipWorkspace(direction);
            }
            if (global.screen.n_workspaces < 2) {
                return false;
            }
            let current = global.screen.get_active_workspace_index();
            let nextIndex = (global.screen.n_workspaces + current + direction) % global.screen.n_workspaces;
            global.screen.get_workspace_by_index(nextIndex).activate(global.get_current_time());
            if (current == global.screen.get_active_workspace_index()) {
                return false;
            }
            Main.wm.showWorkspaceOSD();
            this.refresh('no-switch-windows');
            return true;
        });

        let keysym = event.get_key_symbol();
        let event_state = Cinnamon.get_event_state(event);
        let backwards = event_state & Clutter.ModifierType.SHIFT_MASK;
        let ctrlDown = event_state & Clutter.ModifierType.CONTROL_MASK;
        let action = global.display.get_keybinding_action(event.get_key_code(), event_state);

        const SCROLL_AMOUNT = 5;

        if (pressed) {
            let now = new Date().getTime();
            let ms_diff =  now - (this.lastPressTs || 0);
            this.lastPressTs = now;
            let nowrap = ms_diff < 100;

            if (false) {
            } else if (keysym == Clutter.Escape) {
                this.destroy();
            } else if (keysym == Clutter.Tab) {
                this._select(this._nextApp(nowrap));
            } else if (keysym == Clutter.ISO_Left_Tab) {
                this._select(this._previousApp(nowrap));
            } else if (keysym == Clutter.Home || keysym == Clutter.KP_Home) {
                this._select(ctrlDown && this._homeWindow ? this._indexOfWindow(this._homeWindow) : 0);
            } else if (keysym == Clutter.End || keysym == Clutter.KP_End) {
                this._select(this._appIcons.length - 1);
            } else if (keysym == Clutter.Page_Down || keysym == Clutter.KP_Page_Down) {
                this._select(Math.min(this._appIcons.length - 1, this._currentApp + SCROLL_AMOUNT));
            } else if (keysym == Clutter.Page_Up || keysym == Clutter.KP_Page_Up) {
                this._select(Math.max(0, this._currentApp - SCROLL_AMOUNT));
            } else if (keysym == Clutter.Return) {
                this._finish();
                return true;
            } else if (action == Meta.KeyBindingAction.PANEL_RUN_DIALOG) {
                this.destroy();
                if (this._currentApp >= 0) {
                    let window = this._appIcons[this._currentApp].window;
                    this._activateWindow(window);
                }
                Mainloop.idle_add(function() {
                    Main.getRunDialog().open();
                });
            } else if (action == Meta.KeyBindingAction.WORKSPACE_DOWN || action == Meta.KeyBindingAction.WORKSPACE_UP) {
                if (this._currentApp >= 0) {
                    let window = this._appIcons[this._currentApp].window;
                    this._activateWindow(window);
                }
                this.destroy();
                Mainloop.idle_add(function() {
                    (action == Meta.KeyBindingAction.WORKSPACE_DOWN ? Main.overview : Main.expo).show();
                });
            } else if (action == Meta.KeyBindingAction.SWITCH_GROUP || action == Meta.KeyBindingAction.SWITCH_WINDOWS) {
                this._select(backwards ? this._previousApp(nowrap) : this._nextApp(nowrap));
            } else {
                if (keysym == Clutter.Left) {
                    if (ctrlDown) {
                        if (switchWorkspace(-1)) {
                            return false;
                        }
                    }
                    this._select(this._previousApp(nowrap));
                }
                else if (keysym == Clutter.Right) {
                    if (ctrlDown) {
                        if (switchWorkspace(1)) {
                            return false;
                        }
                    }
                    this._select(this._nextApp(nowrap));
                }
            }
            return true;
        }
        else if (released) {
            if (false) {
            } else if (keysym == Clutter.F1) {
                this._showHelp();
            } else if (keysym == Clutter.KEY_space) {
                if (this._currentApp > -1) {
                    this._showWindowContextMenu(this._appIcons[this._currentApp]);
                }
            } else if (keysym == Clutter.z) {
                this._toggleZoom();
            } else if (keysym == Clutter.h) { // toggle hide
                if (this._hiding) {
                    this._hiding = false;
                    this._appSwitcher.actor.opacity = 255;
                }
                else {
                    this._hiding = true;
                    this._appSwitcher.actor.opacity = 25;
                }
            } else if (keysym == Clutter.g && ctrlDown) {
                if (global.screen.n_workspaces > 1) {
                    g_vars.globalFocusOrder = !g_vars.globalFocusOrder;
                    if (g_vars.globalFocusOrder) {
                        g_settings.allWorkspacesMode = true; // enable together, but disable separately
                    }
                    this.refresh();
                }
            } else if (keysym == Clutter.w && ctrlDown) {
                if (this._currentApp >= 0) {
                    this._appIcons[this._currentApp].window.delete(global.get_current_time());
                }
            } else if (keysym == Clutter.i && ctrlDown) {
                if (this._currentApp >= 0) {
                    let index = g_vars.windowsToIgnore.indexOf(this._appIcons[this._currentApp].window);
                    if (index< 0) {
                        this._appIcons[this._currentApp].ignored = true;
                        g_vars.windowsToIgnore.push(this._appIcons[this._currentApp].window);
                    }
                    else {
                        g_vars.windowsToIgnore.splice(index, 1);
                        this._appIcons[this._currentApp].ignored = false;
                    }
                    this._select(this._currentApp, true); // refresh
                }
            } else if (keysym == Clutter.m && !ctrlDown) {
                let monitorCount = Main.layoutManager.monitors.length;
                if (this._currentApp >= 0 && monitorCount > 1) {
                    let window = this._appIcons[this._currentApp].window;
                    let index = window.get_monitor();
                    let newIndex = (index + monitorCount + 1) % monitorCount;
                    window.move_to_monitor(newIndex);
                    this._select(this._currentApp, true); // refresh
                }
            } else if (keysym == Clutter.n && !ctrlDown) {
                if (this._currentApp >= 0) {
                    let window = this._appIcons[this._currentApp].window;
                    (window.minimized ? window.unminimize : window.minimize).call(window, global.get_current_time());
                    this._select(this._currentApp, true); // refresh
                }
            } else if (keysym == Clutter.F4) {
                let index = g_alttabStyles.indexOf(g_settings.style);
                let newIndex = (index + 1 + g_alttabStyles.length) % g_alttabStyles.length;
                g_settings.style = g_alttabStyles[newIndex];
                processSwitcherStyle();
                this.refresh();
            } else if (keysym == Clutter.F5) {
                g_settings.allWorkspacesMode = !g_settings.allWorkspacesMode;
                this.refresh();
            } else if (keysym == Clutter.F6) {
                if (g_setup._iconsEnabled) {
                    let alignmentTypeIndex = g_aligmentTypes.indexOf(getVerticalAlignment());
                    let newIndex = (alignmentTypeIndex + 1 + g_aligmentTypes.length) % g_aligmentTypes.length;
                    g_settings.vAlign = g_aligmentTypes[newIndex];
                    g_vAlignOverride = null;
                    this.refresh();
                }
            } else if (keysym == Clutter.F7) {
                if (g_setup._iconsEnabled && g_setup._thumbnailsEnabled) {
                    if (getVerticalAlignment() != 'center') {
                        g_settings.displayThumbnailHeaders = !g_settings.displayThumbnailHeaders;
                        this._select(this._currentApp, true); // refresh
                    }
                }
            } else if (keysym == Clutter.F8) {
                if (g_setup._iconsEnabled) {
                    g_settings.compactLabels = !g_settings.compactLabels;
                    this.refresh();
                }
            } else if (keysym == Clutter.F9) {
                if (g_setup._iconsEnabled) {
                    let index = g_thumbnailIconOptions.indexOf(g_settings.thumbnailsBehindIcons);
                    let newIndex = (index + 1 + g_thumbnailIconOptions.length) % g_thumbnailIconOptions.length;
                    g_settings.thumbnailsBehindIcons = g_thumbnailIconOptions[newIndex];
                    this.refresh();
                }
            }
            return true;
        }
        
        return false;
    },

    _showHelp : function() {
        this._persistent = true;
        let dialog = new ModalDialog.ModalDialog();

        let label = new St.Label({text: _("Alt-Tab Quick Help")});
        let bin = new St.Bin();
        bin.child = label;
        dialog.contentLayout.add(bin);
        HELP_TEXT.forEach(function(text) {
            let label = new St.Label({text: text});
            dialog.contentLayout.add(label);
        }, this);

        let altTab = this;
        dialog.setButtons([
            {
                label: _("Open Settings"),
                focused: false,
                action: function() {
                    altTab.destroy();
                    dialog.close();
                    openSettings();
                }
            },
            {
                label: _("Close"),
                focused: true,
                action: function() {
                    dialog.close();
                }
            }
        ]);
        dialog.open();
    },

    _onScroll : function(actor, event) {
        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.UP) {
            this._select(this._previousApp(true));
        } else if (direction == Clutter.ScrollDirection.DOWN) {
            this._select(this._nextApp(true));
        }
    },

    _clickedOutside : function(actor, event) {
        if (!this._menuActive) {
            Mainloop.idle_add(Lang.bind(this, this.destroy));
        }
        return true;
    },

    _activateWindow : function(window) {
        let wsNow = global.screen.get_active_workspace();
        Main.activateWindow(window);
        if (window.get_workspace() != wsNow) {
            Main.wm.showWorkspaceOSD();
        }
    },

    _appActivated : function(sender, n) {
        // If the user clicks on the selected app, activate the
        // selected window; otherwise (e.g., they click on an app while
        // !mouseActive) activate the clicked-on app.
        this._activateWindow(this._appIcons[n].window);
        this.destroy();
    },

    _windowActivated : function(sender, window) {
        this._activateWindow(window);
        this.destroy();
    },

    _finish : function() {
        if (this._appIcons.length > 0 && this._currentApp > -1) {
            let app = this._appIcons[this._currentApp];
            this._activateWindow(app.window);
        }
        this.destroy();
    },

    _popModal: function() {
        if (this._haveModal) {
            Main.popModal(this.actor);
            this._haveModal = false;
        }
    },

    destroy : function() {
        this.actor.destroy();
        this.actor = null;
    },

    _onDestroy : function() {
        this._popModal();

        if (this._motionTimeoutId)
            Mainloop.source_remove(this._motionTimeoutId);
        if (this._thumbnailTimeoutId)
            Mainloop.source_remove(this._thumbnailTimeoutId);
        if (this._initialDelayTimeoutId)
            Mainloop.source_remove(this._initialDelayTimeoutId);
        if (this._displayPreviewTimeoutId)
            Mainloop.source_remove(this._displayPreviewTimeoutId);
        g_vAlignOverride = null;
        g_monitorOverride = null;
    },
    
    _clearPreview: function() {
        if (this._previewClones) {
            this._previewClones.destroy();
            this._previewClones = null;
        }
    },
    
    _doWindowPreview: function() {
        if (!g_setup._previewEnabled || this._appIcons.length < 1 || this._currentApp < 0)
        {
            this._clearPreview();
            if (!g_setup._previewEnabled && this._previewBackdrop) {
                this._previewBackdrop.destroy();
                this._previewBackdrop = null;
            }
            return;
        }

        let showPreview = function() {
            this._displayPreviewTimeoutId = null;
            if (!this._haveModal || this._currentApp < 0) {return;}

            let childBox = new Clutter.ActorBox();

            let window = this._appIcons[this._currentApp].window;
            let app = this._appIcons[this._currentApp].app;

            let previewClones = null;
            let [x1, y1] = [0, 0];
            if (!g_setup._previewThumbnails) {
                previewClones = new St.Group();
                this.actor.add_actor(previewClones);
                let clones = WindowUtils.createWindowClone(window, null, true, false);
                for (let i = 0; i < clones.length; i++) {
                    let clone = clones[i];
                    previewClones.add_actor(clone.actor);
                    let [width, height] = clone.actor.get_size();
                    childBox.x1 = clone.x;
                    childBox.x2 = clone.x + width;
                    childBox.y1 = clone.y;
                    childBox.y2 = clone.y + height;
                    clone.actor.allocate(childBox, 0);
                }
                [x1, y1] = [clones[0].x, clones[0].y];
            }
            else {
                let th = new ThumbnailHolder();
                previewClones = th.actor;
                this.actor.add_actor(previewClones);
                let r = window.get_compositor_private();
                childBox.x1 = r.x;
                childBox.x2 = r.x + r.width;
                childBox.y1 = r.y;
                childBox.y2 = r.y + r.height;
                previewClones.allocate(childBox, 0);
                th.addClones(window, app, false);
                [x1, y1] = [previewClones.x, previewClones.y];
            }

            previewClones.lower(this._appSwitcher.actor);
            if (window.minimized) {
                previewClones.opacity = 192;
            }
            const size = 64;
            let icon = app ? app.create_icon_texture(size) : null;
            if (icon) {
                previewClones.add_actor(icon);
                childBox.x1 = x1;
                childBox.x2 = x1 + size;
                childBox.y1 = y1;
                childBox.y2 = y1 + size;
                icon.allocate(childBox, 0);
            }

            this._clearPreview();
            this._previewClones = previewClones;
            this._previewClones.reactive = true;
            this._previewClones.connect('button-release-event', Lang.bind(this, function() {
                this._activateWindow(window);}
            ));

            if (this._previewBackdrop) {return;}

            let backdrop = Meta.BackgroundActor.new_for_screen(global.screen);
            if (!backdrop) {
                backdrop = this._previewBackdrop = new St.Bin();
                backdrop.style = "background-color: rgba(0,0,0,0.9)";
            }

            if (backdrop) {
                this._previewBackdrop = backdrop;
                this.actor.add_actor(backdrop);
                backdrop.lower(this._appSwitcher.actor);
                backdrop.lower(previewClones);
                childBox.x1 = this.actor.x;
                childBox.x2 = this.actor.x + this.actor.width;
                childBox.y1 = this.actor.y;
                childBox.y2 = this.actor.y + this.actor.height;
                backdrop.allocate(childBox, 0);
            }
        }; // showPreview

        // Use a cancellable timeout to avoid flickering effect when tabbing rapidly through the set.
        if (this._displayPreviewTimeoutId) {
            Mainloop.source_remove(this._displayPreviewTimeoutId);
        }
        let delay = this._previewOnce ? PREVIEW_DELAY_TIMEOUT : PREVIEW_DELAY_TIMEOUT/2;
        this._displayPreviewTimeoutId = Mainloop.timeout_add(delay, Lang.bind(this, showPreview));
        this._previewOnce = true;
    },
    
    /**
     * _select:
     * @app: index of the app to select
     */
    _select : function(app, force) {
        let same = this._currentApp == app;
        if (same && !force) {
            return;
        }
        if (this._thumbnailTimeoutId) {
            Mainloop.source_remove(this._thumbnailTimeoutId);
            this._thumbnailTimeoutId = 0;
        }

        this._currentApp = app;
        if (this._currentApp >= 0) {
            this._selectedWindow = this._appIcons[this._currentApp].window;
        }
        if (this._appIcons.length < 1) {
            return;
        }

        this._appIcons[app].updateLabel();
        this._appSwitcher.highlight(app, false);
        this._doWindowPreview();
        if (g_setup._thumbnailsEnabled && g_setup._iconsEnabled) {
            this._destroyThumbnails();
            if (this._thumbnailTimeoutId) {
                Mainloop.source_remove(this._thumbnailTimeoutId);
            }
            this._thumbnailTimeoutId = Mainloop.timeout_add(
                this.thumbnailOnce ? PREVIEW_DELAY_TIMEOUT : PREVIEW_DELAY_TIMEOUT/2, Lang.bind(this, function() {
                    this._thumbnailTimeoutId = null;
                    this.thumbnailOnce = true;
                    this._createThumbnails();
            }));
        }
    },

    _destroyThumbnails : function() {
        if (!this._thumbnails) {
            return;
        }
        if (!g_setup._thumbnailsEnabled) {
            this._thumbnails.actor.destroy();
            this._thumbnails = null;
            return;
        }
        this._thumbnails.addClones(null);
        this.thumbnailsVisible = false;
    },

    _createThumbnails : function() {
        if (!this._thumbnails) {
            this._thumbnails = new ThumbnailHolder();
            this._thumbnails.connect('item-activated', Lang.bind(this, this._windowActivated));
            this.actor.add_actor(this._thumbnails.actor);
            // Need to force an allocation so we can figure out the dimensions
            this._thumbnails.actor.get_allocation_box();
        }
        this._thumbnails.addClones(this._appIcons[this._currentApp].cachedWindows[0], this._appIcons[this._currentApp].app, true);
        this.thumbnailsVisible = true;
    }
};

function AppSwitcher() {
    this._init.apply(this, arguments);
}

AppSwitcher.prototype = {
    _init : function(windows, showThumbnails, showIcons, altTabPopup) {
        this.actor = new Cinnamon.GenericContainer({ style_class: 'switcher-list' });
        this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this.actor.connect('allocate', Lang.bind(this, this._allocateTop));
        this.actor.connect('destroy', Lang.bind(this, function() {
            if (this._highlightTimeout) {Mainloop.source_remove(this._highlightTimeout);}
        }));

        // Here we use a GenericContainer so that we can force all the
        // children except the separator to have the same width.
        this._list = new Cinnamon.GenericContainer({ style_class: 'switcher-list-item-container' });
        this._list.spacing = 0;
        this._list.connect('style-changed', Lang.bind(this, function() {
                                                        this._list.spacing = this._list.get_theme_node().get_length('spacing');
                                                     }));

        this._list.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this._list.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this._list.connect('allocate', Lang.bind(this, this._allocate));

        this._clipBin = new St.Bin({style_class: 'cbin'});
        this._clipBin.child = this._list;
        this.actor.add_actor(this._clipBin);

        let pointerTracker = new PointerTracker.PointerTracker();
        this._leftGradient = new St.BoxLayout({style_class: 'thumbnail-scroll-gradient-left', vertical: true, reactive: true});
        this._leftGradient.connect('enter-event', Lang.bind(this, function() {
            if (pointerTracker.hasMoved() && this._scrollableLeft) {
                Tweener.addTween(this._list, { anchor_x: 0,
                    time: POPUP_SCROLL_TIME,
                    transition: 'linear',
                    onComplete: this.determineScrolling,
                    onCompleteScope: this
                });
            }
        }));

        this._rightGradient = new St.BoxLayout({style_class: 'thumbnail-scroll-gradient-right', vertical: true, reactive: true});
        this._rightGradient.connect('enter-event', Lang.bind(this, function() {
            if (pointerTracker.hasMoved() && this._scrollableRight) {
                let padding = this.actor.get_theme_node().get_horizontal_padding();
                let parentPadding = this.actor.get_parent().get_theme_node().get_horizontal_padding();
                let x = this._items[this._items.length - 1].allocation.x2 - g_myMonitor.width + padding + parentPadding;
                Tweener.addTween(this._list, { anchor_x: x,
                    time: POPUP_SCROLL_TIME,
                    transition: 'linear',
                    onComplete: this.determineScrolling,
                    onCompleteScope: this
                });
            }
        }));

        this._rightGradient.style = this._leftGradient.style = "border-radius: 0";
        this.actor.add_actor(this._leftGradient);
        this.actor.add_actor(this._rightGradient);

        // Those arrows indicate whether scrolling in one direction is possible
        this._leftArrow = new St.DrawingArea({ style_class: 'switcher-arrow',
                                               pseudo_class: 'highlighted' });
        this._leftArrow.connect('repaint', Lang.bind(this,
            function() { _drawArrow(this._leftArrow, St.Side.LEFT); }));
        this._rightArrow = new St.DrawingArea({ style_class: 'switcher-arrow',
                                                pseudo_class: 'highlighted' });
        this._rightArrow.connect('repaint', Lang.bind(this,
            function() { _drawArrow(this._rightArrow, St.Side.RIGHT); }));

        this.actor.add_actor(this._leftArrow);
        this.actor.add_actor(this._rightArrow);

        this._items = [];
        this._highlighted = -1;
        this._separators = [];
        this._minSize = 0;
        this._scrollableRight = true;
        this._scrollableLeft = false;

        // Construct the AppIcons, add to the popup
        let activeWorkspace = global.screen.get_active_workspace();
        let workspaceIcons = [];
        for (let i = 0; i < windows.length; i++) {
            let appIcon = new AppIcon(windows[i], showThumbnails, showIcons);
            // Cache the window list now; we don't handle dynamic changes here,
            // and we don't want to be continually retrieving it
            appIcon.cachedWindows = [windows[i]];
            workspaceIcons.push(appIcon);
        }

        this.icons = [];
        let lastWsIndex = 0;
        workspaceIcons.forEach(function(icon) {
            let wsIndex = icon.window.get_workspace().index();
            for (let i = wsIndex - lastWsIndex; g_settings.allWorkspacesMode && i > 0; --i) {
                this.addSeparator();
                lastWsIndex = wsIndex;
            }
            this._addIcon(icon);
        }, this);
        for (let i = lastWsIndex + 1; g_settings.allWorkspacesMode && i < global.screen.n_workspaces; ++i) {
            this.addSeparator();
        }

        this._prevApp = this._curApp = -1;
        this._iconSize = 0;
        this._altTabPopup = altTabPopup;
        this._mouseTimeOutId = 0;
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        if (this._items.length < 1) {
            alloc.min_size = alloc.natural_size = 32;
            return;
        }
        // using the current index may lead to sligthly varying heights when scrolling
        // using the current index + 1 leads to jumping when scrolling backwards
        let modelIndex = (this._curApp + this._items.length + 2) % this._items.length;

        let themeNode = this._items[modelIndex].get_theme_node();
        let iconPadding = themeNode.get_horizontal_padding();
        let iconVPadding = themeNode.get_vertical_padding();
        let iconBorder = themeNode.get_border_width(St.Side.LEFT) + themeNode.get_border_width(St.Side.RIGHT);
        let [labelMinHeight, labelNaturalHeight] = this.icons[modelIndex]._label_bin.get_preferred_height(-1);
        let iconSpacing = iconPadding + iconBorder;
        let totalSpacing = this._list.spacing * (this._items.length - 1);
        if (this._separators.length)
           totalSpacing += Math.max(1, this._separators.length - 1) * (this._separators[0].width + this._list.spacing);

        // We just assume the whole screen here due to weirdness happing with the passed width
        let primary = g_myMonitor;
        let parentPadding = this.actor.get_parent().get_theme_node().get_horizontal_padding();
        let availWidth = primary.width - parentPadding - this.actor.get_theme_node().get_horizontal_padding();
        let height = 0;

        for(let i =  0; i < iconSizes.length; i++) {
            this._iconSize = iconSizes[i];
            height = this._iconSize + labelNaturalHeight + iconVPadding;
            let w = totalSpacing;
            if (this._altTabPopup._numPrimaryItems != this.icons.length) {
                let width = this._iconSize + themeNode.get_horizontal_padding() + iconBorder;
                w += width * this._altTabPopup._numPrimaryItems;
            }
            else {
                for(let ii = 0; ii < this._altTabPopup._numPrimaryItems; ii++) {
                    w += this.icons[ii].calculateSlotSize(this._iconSize) + iconSpacing * 2;
                }
            }
            if (w <= availWidth) {
                    break;
            }
        }   

        if (this._items.length == 1) {
            this._iconSize = iconSizes[0];
            height = iconSizes[0] + labelNaturalHeight + iconVPadding;
        }

        for(let i = 0; i < this.icons.length; i++) {
            if (this.icons[i].icon != null)
                break;
            this.icons[i].set_size(this._iconSize);
        }

        alloc.min_size = height;
        alloc.natural_size = height;
    },

    _getArrowDimensions: function() {
        let arrowHeight = Math.floor(this.actor.get_theme_node().get_padding(St.Side.BOTTOM) / 3);
        let arrowWidth = arrowHeight * 2;
        return [arrowWidth, arrowHeight];
    },

    _indicateItem: function(index, id, direction) {
        if (this[id]) {
            this[id].destroy();
            this[id] = 0;
        }
        if (index < 0) {
            return;
        }

        let arrow = this[id] = new St.DrawingArea({ style_class: 'switcher-arrow' });
        arrow.connect('repaint', Lang.bind(this, function() {
            _drawArrow(arrow, direction);
        }));
        this._list.add_actor(arrow);

        // First, find the tallest item in the list
        let height = 0;
        for (let i = 0; i < this._items.length; i++) {
            height = Math.max(height, this._items[i].allocation.y2 - this._items[i].allocation.y1);
        }

        let childBox = new Clutter.ActorBox();
        let [arrowWidth, arrowHeight] = this._getArrowDimensions();
        let itemBox = this._items[index].allocation;

        childBox.x1 = Math.floor(itemBox.x1 + (itemBox.x2 - itemBox.x1 - arrowWidth) / 2);
        childBox.x2 = childBox.x1 + arrowWidth;
        childBox.y1 = height + arrowHeight;
        childBox.y2 = childBox.y1 + arrowHeight;
        arrow.allocate(childBox, 0);
    },

    highlight : function(n, justOutline) {
        if (this._prevApp != -1) {
            this.icons[this._prevApp].set_size(this._iconSize);
        }

        this.highlightInner(n, justOutline);
        this._prevApp = this._curApp = n;
 
        if (this._curApp != -1 && g_setup._iconsEnabled) {
            this.icons[this._curApp].set_size(this._iconSize, true);
        }
    },

    _removeIcon : function(index) {
        let icon = this.icons[index];
        this.icons.splice(index, 1);
        this._items[index].destroy();
        this._items.splice(index, 1);
        if (index < this._prevApp) {
            this._prevApp = this._prevApp - 1;
        }
        else if (index == this._prevApp) {
            this._prevApp = -1;
        }
        
        if (index < this._curApp) {
            this._highlighted = this._curApp = this._curApp - 1;
        }
        else if (index == this._curApp) {
            this._curApp = Math.min(this._curApp, this.icons.length - 1);
            this._highlighted = -1;
        }
        icon.actor.destroy();
    },

    _addIcon : function(appIcon) {
        this.icons.push(appIcon);
        this.addItem(appIcon.actor, appIcon.label);
        appIcon._checkAttention();
    },

    _allocateTop: function(actor, box, flags) {
        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);

        let childBox = new Clutter.ActorBox();
        let scrollable = this._minSize > box.x2 - box.x1;

        this._clipBin.allocate(box, flags);

        childBox.x1 = 0;
        childBox.y1 = 0;
        childBox.x2 = this._leftGradient.width;
        childBox.y2 = this.actor.height;
        this._leftGradient.allocate(childBox, flags);
        this._leftGradient.opacity = (this._scrollableLeft && scrollable) ? 255 : 0;

        childBox.x1 = (this.actor.allocation.x2 - this.actor.allocation.x1) - this._rightGradient.width;
        childBox.y1 = 0;
        childBox.x2 = childBox.x1 + this._rightGradient.width;
        childBox.y2 = this.actor.height;
        this._rightGradient.allocate(childBox, flags);
        this._rightGradient.opacity = (this._scrollableRight && scrollable) ? 255 : 0;

        let arrowWidth = Math.floor(leftPadding / 3);
        let arrowHeight = arrowWidth * 2;
        childBox.x1 = leftPadding / 2;
        childBox.y1 = this.actor.height / 2 - arrowWidth;
        childBox.x2 = childBox.x1 + arrowWidth;
        childBox.y2 = childBox.y1 + arrowHeight;
        this._leftArrow.allocate(childBox, flags);
        this._leftArrow.opacity = this._leftGradient.opacity;

        arrowWidth = Math.floor(rightPadding / 3);
        arrowHeight = arrowWidth * 2;
        childBox.x1 = this.actor.width - rightPadding / 2;
        childBox.y1 = this.actor.height / 2 - arrowWidth;
        childBox.x2 = childBox.x1 + arrowWidth;
        childBox.y2 = childBox.y1 + arrowHeight;
        this._rightArrow.allocate(childBox, flags);
        this._rightArrow.opacity = this._rightGradient.opacity;
    },

    addItem : function(item, label) {
        let bbox = new St.Button({ style_class: 'item-box',
                                   reactive: true });
        item._bbox = bbox;
        bbox.set_child(item);
        this._list.add_actor(bbox);

        let n = this._items.length;
        bbox.connect('button-release-event', Lang.bind(this, function(actor, event) {
            if (event.get_button()==1) {
                this.emit('item-activated', n);
            }
            if (event.get_button()==3) {
                this.emit('item-context-menu', n);
            }
        }));

        this._hoverTimeout = null;
        // There may occur spurious motion events, so use a pointer tracker to verify that the pointer has moved.
        // The detection is not completely fail-safe, due to the effects of scrolling, but it is better than nothing.
        let pointerTracker = new PointerTracker.PointerTracker();
        bbox.connect('enter-event', Lang.bind(this, function() {
            if (pointerTracker.hasMoved()) {
                if (this._hoverTimeout) {
                    Mainloop.source_remove(this._hoverTimeout);
                }
                this._hoverTimeout = Mainloop.timeout_add(125, Lang.bind(this, function() {
                    this._hoverTimeout = null;
                        this.emit('hover', n);
                }));
            }
        }));
        bbox.connect('leave-event', Lang.bind(this, function() {
            if (pointerTracker.hasMoved()) {
                if (this._hoverTimeout) {
                    Mainloop.source_remove(this._hoverTimeout);
                    this._hoverTimeout = null;
                }
            }
        }));
        this._items.push(bbox);
    },

    addSeparator: function () {
        if (!g_vars.globalFocusOrder) {
            let box = new St.Bin({ style_class: 'separator' });
            this._separators.push(box);
            this._list.add_actor(box);
        }
    },

    highlightInner: function(index, justOutline) {
        let prevIndex = this._highlighted;
        // If previous index is negative, we are probably initializing, and we want
        // to show as many of the current workspace's windows as possible.

        let direction = prevIndex == -1 ? 1 : index - prevIndex;
        if (this._highlighted != -1) {
            this._items[this._highlighted].remove_style_pseudo_class('outlined');
            this._items[this._highlighted].remove_style_pseudo_class('selected');
        }
        this._highlighted = index;
        if (this._highlighted != -1) {
            this._items[this._highlighted].add_style_pseudo_class(justOutline ? 'outlined' : 'selected');
        }
        if (!this._noscroll) {
            // If we're close to either the left or the right edge, we want to scroll
            // the edge-most items into view.
            let scrollMax = Math.min(this._noscroll ? 1 : 5, Math.floor(this._items.length/4));
            this._scrollTo(index, direction, scrollMax, prevIndex == -1);
        }
        else {
            this.determineScrolling();
        }
    },

    _getStagePosX: function(actor, offset) {
        let [absItemX, absItemY] = actor.get_transformed_position();
        let [result, posX, posY] = this.actor.transform_stage_point(absItemX, 0);
        return Math.round(posX + actor.width * (offset || 0));
    },

    determineScrolling: function() {
        if (!this._items.length) {
            return;
        }
        let theme_node = this.actor.get_stage() ? this.actor.get_theme_node() : null;
        if (!theme_node) {return;}

        let [containerWidth, containerHeight] = this.actor.get_transformed_size();
        let padding = theme_node.get_horizontal_padding();

        let rightX = this._getStagePosX(this._items[this._items.length - 1], 0.5);
        let leftX = this._getStagePosX(this._items[0], 0.7);
        let scrollableLeft = leftX < padding/2;
        let scrollableRight = rightX >= containerWidth;

        this._scrollableLeft = scrollableLeft;
        this._leftArrow.opacity = this._leftGradient.opacity = scrollableLeft ? 255 : 0;
        this._scrollableRight = scrollableRight;
        this._rightArrow.opacity = this._rightGradient.opacity = scrollableRight ? 255: 0;
        Mainloop.idle_add(Lang.bind(this, function() {
            if (!this._clipBin.get_stage()) {return;}
            if (this._scrollableLeft){
                this._clipBin.lower(this._leftGradient);
            }
            else {
                this._leftGradient.lower(this._clipBin);
            }
            if (this._scrollableRight){
                this._clipBin.lower(this._rightGradient);
            }
            else {
                this._rightGradient.lower(this._clipBin);
            }
        }));
    },

    _scrollTo: function(index, direction, scrollMax_, fast) {        
        let scrollMax = scrollMax_ ? scrollMax_ : 1;
        let ixScroll = direction > 0 ?
            Math.min(index + scrollMax, this._items.length - 1) : // right
            Math.max(index - scrollMax, 0); // left

        let posX = this._getStagePosX(this._items[ixScroll]);
        let [containerWidth, containerHeight] = this.actor.get_transformed_size();
        
        let padding = this.actor.get_theme_node().get_horizontal_padding();

        let delay = fast ? 0 : 250;
        let scrollit = Lang.bind(this, function(x) {
            if (this._highlightTimeout3) {
                Mainloop.source_remove(this._highlightTimeout3);
            }
            this._highlightTimeout3 = Mainloop.timeout_add(delay, Lang.bind(this, function() {
                Tweener.addTween(this._list, { anchor_x: x,
                    time: fast ? 0 : POPUP_SCROLL_TIME,
                    transition: 'linear',
                    onComplete: this.determineScrolling,
                    onCompleteScope: this
                });
            }));
        });

        if (direction > 0) {
            if (posX + this._items[ixScroll].get_width() >= containerWidth) {
                Tweener.removeTweens(this._list);
                let monitor = g_myMonitor;
                let parentPadding = this.actor.get_parent().get_theme_node().get_horizontal_padding();
                let x = this._items[ixScroll].allocation.x2 - monitor.width + padding + parentPadding;
                scrollit(x);
            }
        }
        else if (direction < 0) {
            if (posX <= padding) {
                Tweener.removeTweens(this._list);
                let x = (ixScroll == 0 ? this._list.get_children() : this._items)[ixScroll].allocation.x1;
                scrollit(x);
            }
        }
    },

    _maxChildWidth: function (forHeight) {
        let maxChildMin = 0;
        let maxChildNat = 0;

        for (let i = 0; i < this._items.length; i++) {
            let [childMin, childNat] = this._items[i].get_preferred_width(forHeight);
            maxChildMin = Math.max(childMin, maxChildMin);
            maxChildNat = Math.max(childNat, maxChildNat);
        }

        return [maxChildMin, maxChildNat];
    },

    _getPreferredWidth: function (actor, forHeight, alloc) {
        let separatorWidth = 0;
        if (this._separators.length) {
            let [sepMin, sepNat] = this._separators[0].get_preferred_width(forHeight);
            separatorWidth = this._separators.length * (sepNat + this._list.spacing);
        }

        let totalSpacing = this._list.spacing * Math.max(1, (this._items.length - 1));
        let accItemWidth = 0;
        for (let i = 0; i < this._items.length; i++) {
            let [childMin, childNat] = this._items[i].get_preferred_width(forHeight);
            accItemWidth += childMin;
        }
        alloc.min_size = accItemWidth + separatorWidth + totalSpacing;
        alloc.natural_size = alloc.min_size;
        this._minSize = alloc.min_size;
    },

    _allocate: function (actor, box, flags) {
        let childHeight = box.y2 - box.y1;

        let [maxChildMin, maxChildNat] = this._maxChildWidth(childHeight);
        let totalSpacing = this._list.spacing * (this._items.length - 1);

        let separatorWidth = 0;
        if (this._separators.length) {
            let [sepMin, sepNat] = this._separators[0].get_preferred_width(childHeight);
            separatorWidth = sepNat;
            totalSpacing += this._separators.length * this._list.spacing;
        }

        let childWidth = Math.floor(Math.max(0, box.x2 - box.x1 - totalSpacing - separatorWidth) / this._items.length);

        let x = 0;
        let children = this._list.get_children();
        let childBox = new Clutter.ActorBox();

        let primary = g_myMonitor;
        let parentRightPadding = this.actor.get_parent().get_theme_node().get_padding(St.Side.RIGHT);
        if (this.actor.allocation.x2 == primary.x + primary.width - parentRightPadding) {
            let ixxi = (this._highlighted + this._items.length) % this._items.length;
            let [childMin, childNat] = this._items[ixxi].get_preferred_width(childHeight);
            childWidth = childMin;
        }

        for (let i = 0; i < children.length; i++) {
            if (this._items.indexOf(children[i]) != -1) {
                let [childMin, childNat] = children[i].get_preferred_height(childWidth);
                let [width, height] = children[i].get_size();
                let vSpacing = Math.floor((childHeight - childNat) / 2);
                childBox.x1 = x;
                childBox.y1 = vSpacing;
                childBox.x2 = x + width;
                childBox.y2 = childBox.y1 + height;
                children[i].allocate(childBox, flags);

                x += this._list.spacing + width;
            } else if (this._separators.indexOf(children[i]) != -1) {
                // We want the separator to be more compact than the rest.
                childBox.x1 = x;
                childBox.y1 = 0;
                childBox.x2 = x + separatorWidth;
                childBox.y2 = childHeight;
                children[i].allocate(childBox, flags);
                x += this._list.spacing + separatorWidth;
            } else {
                // Something else, eg, AppSwitcher's arrows;
                // we don't allocate it.
            }
        }

        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);
        let topPadding = this.actor.get_theme_node().get_padding(St.Side.TOP);
        let bottomPadding = this.actor.get_theme_node().get_padding(St.Side.BOTTOM);

        // Clip the area for scrolling
        this._clipBin.set_clip(0, -topPadding, (this.actor.allocation.x2 - this.actor.allocation.x1) - leftPadding - rightPadding, this.actor.height + bottomPadding);
        this.determineScrolling();
    }
};
Signals.addSignalMethods(AppSwitcher.prototype);

function AppIcon() {
    this._init.apply(this, arguments);
}

AppIcon.prototype = {
    _init: function(window, showThumbnail, showIcons) {
        this.window = window;
        this.ignored = g_vars.windowsToIgnore.indexOf(window) >= 0;
        this.showThumbnail = showThumbnail;
        this.showIcons = showIcons;
        let tracker = Cinnamon.WindowTracker.get_default();
        this.app = tracker.get_window_app(window);
        this.actor = new St.BoxLayout({ style_class: 'alt-tab-app',
                                         vertical: true, y_align: St.Align.START });
        this.actor.connect('destroy', Lang.bind(this, function() {
            if (this._urgencyTimeout) {
                Mainloop.source_remove(this._urgencyTimeout);
            }
        }));
        this.icon = null;

        this._iconBin = new St.Bin();
        this.actor.add(this._iconBin, { x_fill: false, y_fill: false, y_align: St.Align.END } );

        this.label = new St.Label();
        this.label.clutter_text.line_wrap = true;
        this._label_bin = new St.Bin({ x_align: St.Align.MIDDLE, y_align: St.Align.START });
        this._label_bin.add_actor(this.label);
        this.actor.add(this._label_bin);

        this.wsLabel = new St.Label();
        this._wsLabel_bin = new St.Bin({ x_align: St.Align.MIDDLE, y_align: St.Align.START });
        this._wsLabel_bin.add_actor(this.wsLabel);
        this.actor.add(this._wsLabel_bin);
        this.updateLabel();
    },

    _checkAttention: function() {
        if (!this.actor._bbox) {return;}
        if (this._urgencyTimeout) {
            Mainloop.source_remove(this._urgencyTimeout);
            this._urgencyTimeout = 0;
        }
        let bbox = this._iconBin;
        let is_urgent = this.window.is_demanding_attention() || this.window.is_urgent();

        if (is_urgent && !bbox.has_style_class_name(DEMANDS_ATTENTION_CLASS_NAME)) {
            bbox.add_style_class_name(DEMANDS_ATTENTION_CLASS_NAME);
        }
        else if (!is_urgent && bbox.has_style_class_name(DEMANDS_ATTENTION_CLASS_NAME)) {
            bbox.remove_style_class_name(DEMANDS_ATTENTION_CLASS_NAME);
        }
        if (is_urgent) {
            this._urgencyTimeout = Mainloop.timeout_add(5000, Lang.bind(this, this._checkAttention));
        }
    },

    updateLabel: function() {
        let ws = this.window.get_workspace().index();
        this.wsLabel.set_text("(" + (ws + 1) + ")");

        let title = this.window.get_title();
        title = typeof(title) != 'undefined' ? title : (this.app ? this.app.get_name() : "");
        this.label.set_text(title.length && this.window.minimized ? "[" + title + "]" : title);
    },

    calculateSlotSize: function(sizeIn) {
        // Icons are sized smaller if they don't belong to the active workspace
        return this.window.get_workspace() == global.screen.get_active_workspace() ? sizeIn : Math.floor(sizeIn * 3 / 4);
    },

    set_size: function(sizeIn, focused) {
        this._initLabelHeight = this._initLabelHeight || this._label_bin.height;
        let size = this.calculateSlotSize(sizeIn);
        if (this.icon) {this.icon.destroy();}
        if (!this.showIcons || (
            (g_settings.thumbnailsBehindIcons == 'behind-identical' && this.app && this.app.get_windows().length > 1)
            || g_settings.thumbnailsBehindIcons == 'always') ) {
            this.icon = new St.Group();
            let clones = WindowUtils.createWindowClone(this.window, size, true, true);
            for (i in clones) {
                let clone = clones[i];
                this.icon.add_actor(clone.actor);
                clone.actor.set_position(clone.x, clone.y);
            }
            if (this.showIcons) {
                let [width, height] = clones[0].actor.get_size();
                clones[0].actor.set_position(Math.floor((size - width)/2), 0);
                let isize = Math.max(Math.ceil(size * 3/4), iconSizes[iconSizes.length - 1]);
                let icon = createApplicationIcon(this.app, isize);
                this.icon.add_actor(icon);
                icon.set_position(Math.floor((size - isize)/2), size - isize);
            }
        }
        else {
            this.icon = createApplicationIcon(this.app, size);
        }
        // Make some room for the window title.
        this._label_bin.width = Math.floor(size * 1.2);
        this._label_bin.height = !g_settings.compactLabels ? Math.max(this._initLabelHeight * 2, Math.floor(size/2)) : this._initLabelHeight;
        if (this.ignored) {
            this.icon.opacity = 170;
        }
        this._iconBin.child = this.icon;
        this._iconBin.set_size(Math.floor(size * 1.2), sizeIn);
        if (g_vars.globalFocusOrder) {
            this.wsLabel.show();
        }
        else {
            this.wsLabel.hide();
            this.wsLabel.height = 0;
        }
    }
};

function ThumbnailHolder() {
    this._init.apply(this, arguments);
}

ThumbnailHolder.prototype = {
    _init : function() {
        this.headerPadding = 4;
        this.actor = new St.Group({ style_class: 'switcher-list', style: 'padding: 4px;', reactive: true });
        let layout = this.layout = new St.BoxLayout({vertical: true, y_align: St.Align.START });
        this.actor.add_actor(layout);
        let header = this.header = new St.BoxLayout({vertical: false});
        layout.add(header, { x_fill: false, y_fill: false, y_align: St.Align.END });
        this.containerHolder = new St.Group();
        this.layout.add(this.containerHolder, { x_fill: false, y_fill: false, y_align: St.Align.END });
        this.actor.connect('button-press-event', Lang.bind(this, function() {this.emit('item-activated', this._window); }));
    },

    addClones : function (window, app, doScale) {
        this._window = window;
        let old_container = this.container;
        this.container = null;
        if (this.header) {
            this.header.destroy_children();
        }
        if (window) {
            let windowMonitorIndex = window.get_monitor();
            this.container = new St.Group();
            this.containerHolder.add_actor(this.container);
            this.container.opacity = 0;
            let headerHeight = 0;
            let displayHeaders = doScale && g_settings.displayThumbnailHeaders && getVerticalAlignment() != 'center';
            this.header.style = 'padding-top: ' + (displayHeaders ? this.headerPadding : 0) + 'px';
            if (displayHeaders) {
                headerHeight = 32;
                let bin = new St.Group();
                bin.add_actor(createApplicationIcon(app, headerHeight));
                this.header.add(bin, { x_fill: false, y_fill: false, y_align: St.Align.START });
                let label = new St.BoxLayout({vertical: true});
                this.header.add(label, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
                let title = new St.Label({text: window.title});
                label.add(title, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });

                let label2strings = [];
                if (global.screen.n_workspaces > 1) {
                    label2strings.push("[" + Main.getWorkspaceName(window.get_workspace().index()) + "]");
                }
                if (windowMonitorIndex != g_myMonitorIndex) {
                    label2strings.push("(Monitor " + (windowMonitorIndex + 1) + ")");
                }
                if (label2strings.length) {
                    let label2 = new St.Label({text: label2strings.join(" ")});
                    label.add(label2, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
                }
            }

            let hPadding = this.actor.get_theme_node().get_horizontal_padding();
            let vBorder = this.actor.get_theme_node().get_border_width(St.Side.TOP) * 2;
            let vPadding = this.actor.get_theme_node().get_vertical_padding() + this.headerPadding;
            let binHeight = this.actor.allocation.y2 - this.actor.allocation.y1 - headerHeight - vPadding - vBorder;
            let binWidth = this.actor.allocation.x2 - this.actor.allocation.x1 - hPadding;
            this.container.set_size(binWidth, binHeight);

            let clones = WindowUtils.createWindowClone(window, 0, true, false);
            let windowMonitor = Main.layoutManager.monitors[windowMonitorIndex];
            let scaleY = doScale ? binHeight/windowMonitor.height : binHeight/clones[0].actor.height;
            let scaleX = doScale ? binWidth/windowMonitor.width : binWidth/clones[0].actor.width;
            let scale = Math.min(scaleX, scaleY);

            for (let j = 0; j < clones.length; j++) {
                let clone = clones[j];
                this.container.add_actor(clone.actor);

                let childBox = new Clutter.ActorBox();
                childBox.x1 = Math.floor((hPadding + binWidth-clone.actor.width*scale)/2);
                childBox.y1 = Math.floor((vPadding + binHeight-clone.actor.height*scale)/2);
                childBox.x2 = childBox.x1 + clone.actor.width;
                childBox.y2 = childBox.y1 + clone.actor.height;
                clone.actor.allocate(childBox, 0);
                clone.actor.set_scale(scale, scale);
            }
            if (doScale) {
                Tweener.addTween(this.container, { opacity: 255,
                    time: THUMBNAIL_FADE_TIME * 3,
                    transition: 'easeOutQuad'
                });
            }
            else {
                this.container.opacity = 255;
            }
        }

        if (old_container) {
            if (window) {
                Tweener.addTween(old_container, {
                    opacity: 0,
                    time: THUMBNAIL_FADE_TIME * 3,
                    transition: 'easeOutQuad',
                    onComplete: Lang.bind(old_container, old_container.destroy)
                });
            }
            else {
                old_container.destroy();
            }
        }
    }
};
Signals.addSignalMethods(ThumbnailHolder.prototype);

function _drawArrow(area, side) {
    let themeNode = area.get_theme_node();
    let borderColor = themeNode.get_border_color(side);
    let bodyColor = themeNode.get_foreground_color();

    let [width, height] = area.get_surface_size ();
    let cr = area.get_context();

    cr.setLineWidth(1.0);
    Clutter.cairo_set_source_color(cr, borderColor);

    switch (side) {
    case St.Side.TOP:
        cr.moveTo(0, height);
        cr.lineTo(Math.floor(width * 0.5), 0);
        cr.lineTo(width, height);
        break;

    case St.Side.BOTTOM:
        cr.moveTo(width, 0);
        cr.lineTo(Math.floor(width * 0.5), height);
        cr.lineTo(0, 0);
        break;

    case St.Side.LEFT:
        cr.moveTo(width, height);
        cr.lineTo(0, Math.floor(height * 0.5));
        cr.lineTo(width, 0);
        break;

    case St.Side.RIGHT:
        cr.moveTo(0, 0);
        cr.lineTo(width, Math.floor(height * 0.5));
        cr.lineTo(0, height);
        break;
    }

    cr.strokePreserve();

    Clutter.cairo_set_source_color(cr, bodyColor);
    cr.fill();
}

function init(metadata, instanceId) {
    g_uuid = metadata['uuid'];
    if (Settings) {
        let settings = instanceId
            ? new Settings.AppletSettings(g_settings, metadata['uuid'], instanceId)
            : new Settings.ExtensionSettings(g_settings, metadata['uuid']);

        settings.bindProperty(Settings.BindingDirection.IN,
            "style",
            "style",
            processSwitcherStyle,
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "thumbnails-behind-icons",
            "thumbnailsBehindIcons",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "all-workspaces-mode",
            "allWorkspacesMode",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "vertical-alignment",
            "vAlign",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "display-thumbnail-headers",
            "displayThumbnailHeaders",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "display-origin-arrow",
            "displayOriginArrow",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "compact-labels",
            "compactLabels",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "preferred-monitor",
            "preferredMonitor",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "last-gsettings-switcher-style",
            "last-gsettings-switcher-style",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "zoom-on",
            "zoom",
            function() {},
            null);
    }
    else {
        // if we don't have local settings support, we must hard-code our preferences
        g_settings.thumbnailsBehindIcons = "behind-identical";
        g_settings.allWorkspacesMode = false;
        g_settings.vAlign = 'center';
        g_settings.displayThumbnailHeaders = true;
        g_settings.displayOriginArrow = true;
        g_settings.compactLabels = false;
        g_settings.zoom = true;
        g_settings.preferredMonitor = ":primary";
    }

    let oldstyle = g_settings["last-gsettings-switcher-style"];
    getSwitcherStyle();
}

function enable() {
    Meta.keybindings_set_custom_handler('switch-windows', function(display, screen, window, binding) {
        let tabPopup = new AltTabPopup();
        let modifiers = binding.get_modifiers();
        let backwards = modifiers & Meta.VirtualModifier.SHIFT_MASK;
        tabPopup.show(backwards, binding.get_name(), binding.get_mask());
    });
}

function disable() {
    Meta.keybindings_set_custom_handler('switch-windows',
        Lang.bind(Main.wm, Main.wm._startAppSwitcher));
}

// ----------------------------------

function MyApplet() {
    this._init.apply(this, arguments);
}


MyApplet.prototype = {
    __proto__: Applet.IconApplet.prototype,

    _init: function(metadata, orientation, panel_height, instanceId) {
        this.orientation = orientation;
        Applet.IconApplet.prototype._init.call(this, orientation, panel_height, instanceId);
        this.path = metadata.path;
    },

    on_applet_added_to_panel: function() {
        this.set_applet_icon_path(this.path + "/icon.png");
        this.set_applet_tooltip("Alt-Tab Enhanced");
        let item = new PopupMenu.PopupMenuItem(_("Settings"));
        item.connect('activate', openSettings);
        this._applet_context_menu.addMenuItem(item);
        enable();
    },

    on_applet_removed_from_panel: function(event) {
        disable();
    },

    on_applet_clicked: function(event) {
        g_vAlignOverride = this.orientation == St.Side.BOTTOM ? 'bottom' : 'top';
        g_monitorOverride = Main.layoutManager.findMonitorForActor(this.actor);
        let tabPopup = new AltTabPopup();
        tabPopup._persistent = true;
        tabPopup.show(false, 'no-switch-windows');
    },
    
    on_orientation_changed: function (orientation) {
        this.orientation = orientation;
    }
};

function main(metadata, orientation, panel_height, instanceId) {
    init(metadata, instanceId);
    return new MyApplet(metadata, orientation, panel_height, instanceId);
}
