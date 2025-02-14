import { Transaction as TransactionType } from "@sentry/types";
import { getGlobalObject, logger } from "@sentry/utils";

import { BeforeNavigate } from "./reactnativetracing";
import {
  RoutingInstrumentation,
  TransactionCreator,
} from "./routingInstrumentation";
import { ReactNavigationTransactionContext } from "./types";

export interface NavigationRouteV5 {
  name: string;
  key: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any>;
}

interface NavigationContainerV5 {
  addListener: (type: string, listener: () => void) => void;
  getCurrentRoute: () => NavigationRouteV5;
}

interface ReactNavigationV5Options {
  /**
   * The time the transaction will wait for route to mount before it is discarded.
   */
  routeChangeTimeoutMs: number;
}

const defaultOptions: ReactNavigationV5Options = {
  routeChangeTimeoutMs: 1000,
};

/**
 * Instrumentation for React-Navigation V5. See docs or sample app for usage.
 *
 * How this works:
 * - `_onDispatch` is called every time a dispatch happens and sets an IdleTransaction on the scope without any route context.
 * - `_onStateChange` is then called AFTER the state change happens due to a dispatch and sets the route context onto the active transaction.
 * - If `_onStateChange` isn't called within `STATE_CHANGE_TIMEOUT_DURATION` of the dispatch, then the transaction is not sampled and finished.
 */
export class ReactNavigationV5Instrumentation extends RoutingInstrumentation {
  public static instrumentationName: string = "react-navigation-v5";

  private _navigationContainer: NavigationContainerV5 | null = null;

  private readonly _maxRecentRouteLen: number = 200;

  private _latestRoute?: NavigationRouteV5;
  private _latestTransaction?: TransactionType;
  private _initialStateHandled: boolean = false;
  private _stateChangeTimeout?: number | undefined;
  private _recentRouteKeys: string[] = [];

  private _options: ReactNavigationV5Options;

  public constructor(options: Partial<ReactNavigationV5Options> = {}) {
    super();

    this._options = {
      ...defaultOptions,
      ...options,
    };
  }

  /**
   * Extends by calling _handleInitialState at the end.
   */
  public registerRoutingInstrumentation(
    listener: TransactionCreator,
    beforeNavigate: BeforeNavigate
  ): void {
    super.registerRoutingInstrumentation(listener, beforeNavigate);

    // We create an initial state here to ensure a transaction gets created before the first route mounts.
    if (!this._initialStateHandled) {
      this._onDispatch();
      if (this._navigationContainer) {
        // Navigation container already registered, just populate with route state
        this._onStateChange();

        this._initialStateHandled = true;
      }
    }
  }

  /**
   * Pass the ref to the navigation container to register it to the instrumentation
   * @param navigationContainerRef Ref to a `NavigationContainer`
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
  public registerNavigationContainer(navigationContainerRef: any): void {
    const _global = getGlobalObject<{ __sentry_rn_v5_registered?: boolean }>();

    /* We prevent duplicate routing instrumentation to be initialized on fast refreshes

      Explanation: If the user triggers a fast refresh on the file that the instrumentation is
      initialized in, it will initialize a new instance and will cause undefined behavior.
     */
    if (!_global.__sentry_rn_v5_registered) {
      if ("current" in navigationContainerRef) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        this._navigationContainer = navigationContainerRef.current;
      } else {
        this._navigationContainer = navigationContainerRef;
      }

      if (this._navigationContainer) {
        this._navigationContainer.addListener(
          "__unsafe_action__", // This action is emitted on every dispatch
          this._onDispatch.bind(this)
        );
        this._navigationContainer.addListener(
          "state", // This action is emitted on every state change
          this._onStateChange.bind(this)
        );

        if (!this._initialStateHandled) {
          if (this._latestTransaction) {
            // If registerRoutingInstrumentation was called first _onDispatch has already been called
            this._onStateChange();

            this._initialStateHandled = true;
          } else {
            logger.log(
              "[ReactNavigationV5Instrumentation] Navigation container registered, but integration has not been setup yet."
            );
          }
        }

        _global.__sentry_rn_v5_registered = true;
      } else {
        logger.warn(
          "[ReactNavigationV5Instrumentation] Received invalid navigation container ref!"
        );
      }
    } else {
      logger.log(
        "[ReactNavigationV5Instrumentation] Instrumentation already exists, but register has been called again, doing nothing."
      );
    }
  }

  /**
   * To be called on every React-Navigation action dispatch.
   * It does not name the transaction or populate it with route information. Instead, it waits for the state to fully change
   * and gets the route information from there, @see _onStateChange
   */
  private _onDispatch(): void {
    this._latestTransaction = this.onRouteWillChange(
      BLANK_TRANSACTION_CONTEXT_V5
    );

    this._stateChangeTimeout = setTimeout(
      this._discardLatestTransaction.bind(this),
      this._options.routeChangeTimeoutMs
    );
  }

  /**
   * To be called AFTER the state has been changed to populate the transaction with the current route.
   */
  private _onStateChange(): void {
    // Use the getCurrentRoute method to be accurate.
    const previousRoute = this._latestRoute;

    if (!this._navigationContainer) {
      logger.warn(
        "[ReactNavigationV5Instrumentation] Missing navigation container ref. Route transactions will not be sent."
      );

      return;
    }

    const route = this._navigationContainer.getCurrentRoute();

    if (route) {
      if (
        this._latestTransaction &&
        (!previousRoute || previousRoute.key !== route.key)
      ) {
        const originalContext = this._latestTransaction.toContext() as typeof BLANK_TRANSACTION_CONTEXT_V5;
        const routeHasBeenSeen = this._recentRouteKeys.includes(route.key);

        const updatedContext: ReactNavigationTransactionContext = {
          ...originalContext,
          name: route.name,
          tags: {
            ...originalContext.tags,
            "routing.route.name": route.name,
          },
          data: {
            ...originalContext.data,
            route: {
              name: route.name,
              key: route.key,
              params: route.params ?? {},
              hasBeenSeen: routeHasBeenSeen,
            },
            previousRoute: previousRoute
              ? {
                  name: previousRoute.name,
                  key: previousRoute.key,
                  params: previousRoute.params ?? {},
                }
              : null,
          },
        };

        let finalContext = this._beforeNavigate?.(updatedContext);

        // This block is to catch users not returning a transaction context
        if (!finalContext) {
          logger.error(
            `[ReactNavigationV5Instrumentation] beforeNavigate returned ${finalContext}, return context.sampled = false to not send transaction.`
          );

          finalContext = {
            ...updatedContext,
            sampled: false,
          };
        }

        // Note: finalContext.sampled will be false at this point only if the user sets it to be so in beforeNavigate.
        if (finalContext.sampled === false) {
          logger.log(
            `[ReactNavigationV5Instrumentation] Will not send transaction "${finalContext.name}" due to beforeNavigate.`
          );
        } else {
          // Clear the timeout so the transaction does not get cancelled.
          if (typeof this._stateChangeTimeout !== "undefined") {
            clearTimeout(this._stateChangeTimeout);
            this._stateChangeTimeout = undefined;
          }
        }

        this._latestTransaction.updateWithContext(finalContext);
      }

      this._pushRecentRouteKey(route.key);
      this._latestRoute = route;
    }
  }

  /** Pushes a recent route key, and removes earlier routes when there is greater than the max length */
  private _pushRecentRouteKey = (key: string): void => {
    this._recentRouteKeys.push(key);

    if (this._recentRouteKeys.length > this._maxRecentRouteLen) {
      this._recentRouteKeys = this._recentRouteKeys.slice(
        this._recentRouteKeys.length - this._maxRecentRouteLen
      );
    }
  };

  /** Cancels the latest transaction so it does not get sent to Sentry. */
  private _discardLatestTransaction(): void {
    if (this._latestTransaction) {
      this._latestTransaction.sampled = false;
      this._latestTransaction.finish();
      this._latestTransaction = undefined;
    }
  }
}

export const BLANK_TRANSACTION_CONTEXT_V5 = {
  name: "Route Change",
  op: "navigation",
  tags: {
    "routing.instrumentation":
      ReactNavigationV5Instrumentation.instrumentationName,
  },
  data: {},
};
