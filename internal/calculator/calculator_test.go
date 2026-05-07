package calculator_test

import (
	"testing"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
)

func TestCalculate_EmptyInput(t *testing.T) {
	result := calculator.Calculate(nil)
	if result.DDITokens != 0 || result.IPTokens != 0 || result.AssetTokens != 0 || result.GrandTotal != 0 {
		t.Errorf("expected all zeros for empty input, got %+v", result)
	}
	if result.Findings == nil {
		t.Error("expected non-nil Findings slice for empty input")
	}
}

func TestCalculate_SingleDDIRow_Exact(t *testing.T) {
	findings := []calculator.FindingRow{
		{Provider: "aws", Source: "123456789", Category: "DDI Objects", Item: "vpc", Count: 25, TokensPerUnit: 25},
	}
	result := calculator.Calculate(findings)
	if result.DDITokens != 1 {
		t.Errorf("expected DDITokens=1, got %d", result.DDITokens)
	}
	if result.GrandTotal != 1 {
		t.Errorf("expected GrandTotal=1, got %d", result.GrandTotal)
	}
}

func TestCalculate_SingleDDIRow_Ceiling(t *testing.T) {
	findings := []calculator.FindingRow{
		{Provider: "aws", Source: "123456789", Category: "DDI Objects", Item: "vpc", Count: 26, TokensPerUnit: 25},
	}
	result := calculator.Calculate(findings)
	if result.DDITokens != 2 {
		t.Errorf("expected DDITokens=2 (ceiling), got %d", result.DDITokens)
	}
	if result.GrandTotal != 2 {
		t.Errorf("expected GrandTotal=2, got %d", result.GrandTotal)
	}
}

func TestCalculate_SingleDDIRow_Zero(t *testing.T) {
	findings := []calculator.FindingRow{
		{Provider: "aws", Source: "123456789", Category: "DDI Objects", Item: "vpc", Count: 0, TokensPerUnit: 25},
	}
	result := calculator.Calculate(findings)
	if result.DDITokens != 0 {
		t.Errorf("expected DDITokens=0, got %d", result.DDITokens)
	}
}

func TestCalculate_SingleActiveIPRow_Exact(t *testing.T) {
	findings := []calculator.FindingRow{
		{Provider: "aws", Source: "123456789", Category: "Active IPs", Item: "ec2", Count: 13, TokensPerUnit: 13},
	}
	result := calculator.Calculate(findings)
	if result.IPTokens != 1 {
		t.Errorf("expected IPTokens=1, got %d", result.IPTokens)
	}
	if result.GrandTotal != 1 {
		t.Errorf("expected GrandTotal=1, got %d", result.GrandTotal)
	}
}

func TestCalculate_SingleActiveIPRow_Ceiling(t *testing.T) {
	findings := []calculator.FindingRow{
		{Provider: "aws", Source: "123456789", Category: "Active IPs", Item: "ec2", Count: 14, TokensPerUnit: 13},
	}
	result := calculator.Calculate(findings)
	if result.IPTokens != 2 {
		t.Errorf("expected IPTokens=2 (ceiling), got %d", result.IPTokens)
	}
}

func TestCalculate_SingleManagedAssetRow_Exact(t *testing.T) {
	findings := []calculator.FindingRow{
		{Provider: "aws", Source: "123456789", Category: "Managed Assets", Item: "ec2", Count: 3, TokensPerUnit: 3},
	}
	result := calculator.Calculate(findings)
	if result.AssetTokens != 1 {
		t.Errorf("expected AssetTokens=1, got %d", result.AssetTokens)
	}
	if result.GrandTotal != 1 {
		t.Errorf("expected GrandTotal=1, got %d", result.GrandTotal)
	}
}

func TestCalculate_SingleManagedAssetRow_Ceiling(t *testing.T) {
	findings := []calculator.FindingRow{
		{Provider: "aws", Source: "123456789", Category: "Managed Assets", Item: "ec2", Count: 4, TokensPerUnit: 3},
	}
	result := calculator.Calculate(findings)
	if result.AssetTokens != 2 {
		t.Errorf("expected AssetTokens=2 (ceiling), got %d", result.AssetTokens)
	}
}

func TestCalculate_MixedInput(t *testing.T) {
	findings := []calculator.FindingRow{
		{Provider: "aws", Source: "123456789", Category: "DDI Objects", Item: "vpc", Count: 50, TokensPerUnit: 25},
		{Provider: "aws", Source: "123456789", Category: "Active IPs", Item: "ec2", Count: 26, TokensPerUnit: 13},
		{Provider: "aws", Source: "123456789", Category: "Managed Assets", Item: "ec2", Count: 6, TokensPerUnit: 3},
	}
	result := calculator.Calculate(findings)
	if result.DDITokens != 2 {
		t.Errorf("expected DDITokens=2, got %d", result.DDITokens)
	}
	if result.IPTokens != 2 {
		t.Errorf("expected IPTokens=2, got %d", result.IPTokens)
	}
	if result.AssetTokens != 2 {
		t.Errorf("expected AssetTokens=2, got %d", result.AssetTokens)
	}
	if result.GrandTotal != 2 {
		t.Errorf("expected GrandTotal=2, got %d", result.GrandTotal)
	}
}

func TestCalculate_GrandTotalIsMax(t *testing.T) {
	// DDI=100 objects → DDITokens=4; IP=13 IPs → IPTokens=1; GrandTotal=4 (DDI wins)
	findings := []calculator.FindingRow{
		{Provider: "aws", Source: "123456789", Category: "DDI Objects", Item: "vpc", Count: 100, TokensPerUnit: 25},
		{Provider: "aws", Source: "123456789", Category: "Active IPs", Item: "ec2", Count: 13, TokensPerUnit: 13},
	}
	result := calculator.Calculate(findings)
	if result.DDITokens != 4 {
		t.Errorf("expected DDITokens=4, got %d", result.DDITokens)
	}
	if result.IPTokens != 1 {
		t.Errorf("expected IPTokens=1, got %d", result.IPTokens)
	}
	if result.GrandTotal != 4 {
		t.Errorf("expected GrandTotal=4 (max), got %d", result.GrandTotal)
	}
}

func TestCalculate_AggregationBeforeDivision(t *testing.T) {
	// Two DDI rows each Count=12: correct is ceiling(24/25)=1, wrong naive=ceiling(12/25)+ceiling(12/25)=1+1=2
	findings := []calculator.FindingRow{
		{Provider: "aws", Source: "111111111", Category: "DDI Objects", Item: "vpc", Count: 12, TokensPerUnit: 25},
		{Provider: "aws", Source: "222222222", Category: "DDI Objects", Item: "subnet", Count: 12, TokensPerUnit: 25},
	}
	result := calculator.Calculate(findings)
	if result.DDITokens != 1 {
		t.Errorf("expected DDITokens=1 (aggregation before division: ceiling(24/25)=1), got %d", result.DDITokens)
	}
}

func TestCalculate_PartialResults(t *testing.T) {
	// One provider has counts, another has all zeros
	findings := []calculator.FindingRow{
		{Provider: "aws", Source: "123456789", Category: "DDI Objects", Item: "vpc", Count: 50, TokensPerUnit: 25},
		{Provider: "azure", Source: "sub-xxx", Category: "DDI Objects", Item: "vnet", Count: 0, TokensPerUnit: 25},
		{Provider: "azure", Source: "sub-xxx", Category: "Active IPs", Item: "vm", Count: 0, TokensPerUnit: 13},
	}
	result := calculator.Calculate(findings)
	if result.DDITokens != 2 {
		t.Errorf("expected DDITokens=2 from partial results, got %d", result.DDITokens)
	}
	if result.GrandTotal != 2 {
		t.Errorf("expected GrandTotal=2, got %d", result.GrandTotal)
	}
	if result.IPTokens != 0 {
		t.Errorf("expected IPTokens=0, got %d", result.IPTokens)
	}
}
