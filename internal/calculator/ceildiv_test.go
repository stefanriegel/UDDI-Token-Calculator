package calculator

import "testing"

func TestCeilDiv(t *testing.T) {
	tests := []struct {
		name string
		n, d int
		want int
	}{
		// Divisor 25 (DDI Objects)
		{"0/25", 0, 25, 0},
		{"1/25", 1, 25, 1},
		{"24/25", 24, 25, 1},
		{"25/25", 25, 25, 1},
		{"26/25", 26, 25, 2},

		// Divisor 13 (Active IPs)
		{"0/13", 0, 13, 0},
		{"1/13", 1, 13, 1},
		{"12/13", 12, 13, 1},
		{"13/13", 13, 13, 1},
		{"14/13", 14, 13, 2},

		// Divisor 3 (Managed Assets)
		{"0/3", 0, 3, 0},
		{"1/3", 1, 3, 1},
		{"2/3", 2, 3, 1},
		{"3/3", 3, 3, 1},
		{"4/3", 4, 3, 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CeilDiv(tt.n, tt.d)
			if got != tt.want {
				t.Errorf("CeilDiv(%d, %d) = %d, want %d", tt.n, tt.d, got, tt.want)
			}
		})
	}
}
