import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface DataTablePaginationProps {
  pageIndex: number;
  pageSize: number;
  totalCount: number;
  onPaginationChange: (pagination: { pageIndex: number; pageSize: number }) => void;
}

export function DataTablePagination({
  pageIndex,
  pageSize,
  totalCount,
  onPaginationChange,
}: DataTablePaginationProps) {
  const from = totalCount === 0 ? 0 : pageIndex * pageSize + 1;
  const to = Math.min((pageIndex + 1) * pageSize, totalCount);
  const hasPrevious = pageIndex > 0;
  const hasNext = (pageIndex + 1) * pageSize < totalCount;

  return (
    <div className="flex items-center justify-between pt-4">
      <p className="text-sm text-muted-foreground">
        Showing {from}–{to} of {totalCount}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPaginationChange({ pageIndex: pageIndex - 1, pageSize })}
          disabled={!hasPrevious}
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPaginationChange({ pageIndex: pageIndex + 1, pageSize })}
          disabled={!hasNext}
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
