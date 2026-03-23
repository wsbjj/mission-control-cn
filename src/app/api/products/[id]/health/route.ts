import { NextRequest, NextResponse } from 'next/server';
import { getHealthResponse } from '@/lib/autopilot/health-score';
import { getProduct } from '@/lib/autopilot/products';

/**
 * GET /api/products/[id]/health
 * Returns current score, component breakdown, weights, and 30-day history.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const product = getProduct(params.id);
    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    const response = getHealthResponse(params.id);
    return NextResponse.json(response);
  } catch (error) {
    console.error('[API] Health score error:', error);
    return NextResponse.json(
      { error: 'Failed to compute health score' },
      { status: 500 }
    );
  }
}
