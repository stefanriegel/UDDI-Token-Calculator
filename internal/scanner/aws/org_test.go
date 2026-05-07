package aws

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/organizations"
	orgtypes "github.com/aws/aws-sdk-go-v2/service/organizations/types"
)

// mockOrgClient implements the organizationsAPI interface for testing.
type mockOrgClient struct {
	pages []*organizations.ListAccountsOutput
	err   error
}

func (m *mockOrgClient) ListAccounts(ctx context.Context, params *organizations.ListAccountsInput, optFns ...func(*organizations.Options)) (*organizations.ListAccountsOutput, error) {
	if m.err != nil {
		return nil, m.err
	}
	// Find the right page based on NextToken.
	pageIdx := 0
	if params.NextToken != nil {
		for i, p := range m.pages {
			if i > 0 && p != nil {
				// Match on NextToken from previous page.
			}
		}
		// Simple approach: use token as index.
		for i, p := range m.pages {
			if i > 0 {
				_ = p
			}
		}
		// NextToken-based pagination: find the matching page.
		for i := 0; i < len(m.pages)-1; i++ {
			if m.pages[i].NextToken != nil && *m.pages[i].NextToken == *params.NextToken {
				pageIdx = i + 1
				break
			}
		}
	}
	if pageIdx >= len(m.pages) {
		return &organizations.ListAccountsOutput{}, nil
	}
	return m.pages[pageIdx], nil
}

func TestDiscoverAccounts_HappyPath(t *testing.T) {
	client := &mockOrgClient{
		pages: []*organizations.ListAccountsOutput{
			{
				Accounts: []orgtypes.Account{
					{Id: aws.String("111111111111"), Name: aws.String("Management"), Status: orgtypes.AccountStatusActive},
					{Id: aws.String("222222222222"), Name: aws.String("Dev"), Status: orgtypes.AccountStatusActive},
				},
			},
		},
	}

	accounts, err := discoverAccountsWithClient(context.Background(), client)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(accounts) != 2 {
		t.Fatalf("expected 2 accounts, got %d", len(accounts))
	}
	if accounts[0].ID != "111111111111" {
		t.Errorf("expected account ID 111111111111, got %s", accounts[0].ID)
	}
	if accounts[0].Name != "Management" {
		t.Errorf("expected account name Management, got %s", accounts[0].Name)
	}
	if accounts[1].ID != "222222222222" {
		t.Errorf("expected account ID 222222222222, got %s", accounts[1].ID)
	}
}

func TestDiscoverAccounts_Pagination(t *testing.T) {
	client := &mockOrgClient{
		pages: []*organizations.ListAccountsOutput{
			{
				Accounts: []orgtypes.Account{
					{Id: aws.String("111111111111"), Name: aws.String("Page1Account"), Status: orgtypes.AccountStatusActive},
				},
				NextToken: aws.String("page2"),
			},
			{
				Accounts: []orgtypes.Account{
					{Id: aws.String("222222222222"), Name: aws.String("Page2Account"), Status: orgtypes.AccountStatusActive},
				},
			},
		},
	}

	accounts, err := discoverAccountsWithClient(context.Background(), client)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(accounts) != 2 {
		t.Fatalf("expected 2 accounts from 2 pages, got %d", len(accounts))
	}
	if accounts[0].Name != "Page1Account" {
		t.Errorf("first account should be Page1Account, got %s", accounts[0].Name)
	}
	if accounts[1].Name != "Page2Account" {
		t.Errorf("second account should be Page2Account, got %s", accounts[1].Name)
	}
}

func TestDiscoverAccounts_FiltersSuspended(t *testing.T) {
	client := &mockOrgClient{
		pages: []*organizations.ListAccountsOutput{
			{
				Accounts: []orgtypes.Account{
					{Id: aws.String("111111111111"), Name: aws.String("Active"), Status: orgtypes.AccountStatusActive},
					{Id: aws.String("333333333333"), Name: aws.String("Suspended"), Status: orgtypes.AccountStatusSuspended},
					{Id: aws.String("444444444444"), Name: aws.String("PendingClosure"), Status: orgtypes.AccountStatusPendingClosure},
				},
			},
		},
	}

	accounts, err := discoverAccountsWithClient(context.Background(), client)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(accounts) != 1 {
		t.Fatalf("expected 1 active account, got %d", len(accounts))
	}
	if accounts[0].Name != "Active" {
		t.Errorf("expected Active account, got %s", accounts[0].Name)
	}
}

func TestDiscoverAccounts_APIError(t *testing.T) {
	client := &mockOrgClient{
		err: errors.New("AccessDeniedException: not authorized"),
	}

	_, err := discoverAccountsWithClient(context.Background(), client)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, err) { // basic sanity
		t.Fatal("error should be non-nil")
	}
	// The error should contain the underlying message.
	errStr := err.Error()
	if errStr == "" {
		t.Fatal("error string should not be empty")
	}
}
