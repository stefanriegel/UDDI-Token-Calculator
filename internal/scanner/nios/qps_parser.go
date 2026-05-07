package nios

import (
	"encoding/xml"
	"fmt"
	"io"
	"strconv"
)

// ParseSplunkQPS parses a Splunk XML export containing per-member DNS QPS data
// and returns the peak (max) QPS per member hostname across all time buckets.
//
// Splunk XML structure:
//
//	<results>
//	  <meta><fieldOrder>
//	    <field>_time</field>
//	    <field splitby_field="source_host" splitby_value="hostname">hostname</field>
//	    ...
//	  </fieldOrder></meta>
//	  <result offset='N'>
//	    <field k='_time'><value><text>...</text></value></field>
//	    <field k='hostname'><value><text>QPS_VALUE</text></value></field>
//	    ...
//	  </result>
//	</results>
//
// Uses streaming XML decoding for memory efficiency on large exports (~91K lines).
func ParseSplunkQPS(r io.Reader) (map[string]float64, error) {
	decoder := xml.NewDecoder(r)

	// Phase 1: parse fieldOrder from <meta> to discover member hostnames.
	// Phase 2: iterate <result> elements and track max QPS per member.
	memberHostnames := make([]string, 0) // ordered column names (excluding _time)
	peakQPS := make(map[string]float64)

	// State machine
	type state int
	const (
		stateInit state = iota
		stateFieldOrder
		stateField       // inside <field> in fieldOrder
		stateResult
		stateResultField // inside <field> in result
		stateValue       // inside <value>
		stateText        // inside <text>
	)

	current := stateInit
	var fieldK string   // k attribute of current result <field>
	var textBuf string  // text content of <text>

	for {
		tok, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("splunk XML parse error: %w", err)
		}

		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "fieldOrder":
				current = stateFieldOrder
			case "field":
				if current == stateFieldOrder {
					current = stateField
				} else if current == stateResult || current == stateResultField {
					current = stateResultField
					fieldK = ""
					for _, attr := range t.Attr {
						if attr.Name.Local == "k" {
							fieldK = attr.Value
						}
					}
				}
			case "result":
				current = stateResult
			case "value":
				if current == stateResultField {
					current = stateValue
				}
			case "text":
				if current == stateValue {
					current = stateText
					textBuf = ""
				}
			}

		case xml.CharData:
			if current == stateField {
				// Field text inside fieldOrder is the column name
				name := string(t)
				if name != "" && name != "_time" {
					memberHostnames = append(memberHostnames, name)
				}
			} else if current == stateText {
				textBuf += string(t)
			}

		case xml.EndElement:
			switch t.Name.Local {
			case "fieldOrder":
				current = stateInit
			case "field":
				if current == stateField {
					current = stateFieldOrder
				} else if current == stateResultField || current == stateValue {
					// End of a result field — process the value
					if fieldK != "" && fieldK != "_time" && textBuf != "" {
						if val, err := strconv.ParseFloat(textBuf, 64); err == nil {
							if val > peakQPS[fieldK] {
								peakQPS[fieldK] = val
							}
						}
					}
					current = stateResult
					fieldK = ""
					textBuf = ""
				}
			case "result":
				current = stateInit
			case "value":
				if current == stateValue {
					current = stateResultField
				}
			case "text":
				if current == stateText {
					current = stateValue
				}
			}
		}
	}

	_ = memberHostnames // used for documentation; peakQPS already has all keys
	return peakQPS, nil
}
