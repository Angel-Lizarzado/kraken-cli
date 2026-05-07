// Extend react-window types for v2 compatibility
// @types/react-window@1.8.8 declares FixedSizeList but react-window@2.2.7 exports List
import 'react-window';

declare module 'react-window' {
  // Re-export List as the v2 name (same class as FixedSizeList was in v1)
  export class List<T = any> extends React.Component<ListProps<T>> {
    scrollTo(scrollOffset: number): void;
    scrollToItem(index: number, align?: Align): void;
  }
  
  // ListOnItemsRenderedProps exists in v1 types but may not be accessible
  export { ListOnItemsRenderedProps };
}
