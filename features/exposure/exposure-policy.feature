Feature: What a worker opens beyond the tailnet is declared in the fleet configuration
  A rented worker has a public address from its first second. The exposure
  policy says what it opens beyond loopback and the tailnet: fleet-wide as
  "exposure" in the worker policy, and for one worker as "exposure" beside its
  network. A field a worker names replaces the fleet-wide one. Without a
  declaration nothing is public.

  Scenario: A fleet that declares nothing opens nothing
    Given the fleet configuration of the example
    When the exposure of "worker-one" is read
    Then the exposure is:
      | publicSsh      | false |
      | publicPorts    | none  |
      | otherListeners | warn  |

  Scenario: A worker's own declaration replaces the fleet-wide fields it names
    Given the fleet configuration of the example
    And the worker policy declares the exposure:
      """
      {"otherListeners": "fail", "publicPorts": [{"protocol": "tcp", "port": 8080}]}
      """
    And "worker-two" declares the exposure:
      """
      {"publicSsh": true}
      """
    When the exposure of "worker-two" is read
    Then the exposure is:
      | publicSsh      | true     |
      | publicPorts    | tcp/8080 |
      | otherListeners | fail     |

  Scenario: Another worker keeps the fleet-wide declaration
    Given the fleet configuration of the example
    And the worker policy declares the exposure:
      """
      {"otherListeners": "fail"}
      """
    And "worker-two" declares the exposure:
      """
      {"publicSsh": true, "otherListeners": "warn"}
      """
    When the exposure of "worker-one" is read
    Then the exposure is:
      | publicSsh      | false |
      | publicPorts    | none  |
      | otherListeners | fail  |

  Scenario Outline: A declaration that <breaks> is refused where it is written
    Given the fleet configuration of the example
    And "worker-one" declares the exposure:
      """
      <declaration>
      """
    When the fleet configuration is read
    Then it is refused at "$.workers[0].exposure"

    Examples:
      | breaks                         | declaration                                                                         |
      | names an unknown field         | {"publicHttp": true}                                                                |
      | says yes for true              | {"publicSsh": "yes"}                                                                |
      | opens port 0                   | {"publicPorts": [{"protocol": "tcp", "port": 0}]}                                   |
      | names a protocol that is not one | {"publicPorts": [{"protocol": "icmp", "port": 1}]}                                |
      | opens one port twice           | {"publicPorts": [{"protocol": "tcp", "port": 80}, {"protocol": "tcp", "port": 80}]} |
      | ignores other listeners        | {"otherListeners": "ignore"}                                                        |

  Scenario: The fleet-wide declaration is checked like the worker's
    Given the fleet configuration of the example
    And the worker policy declares the exposure:
      """
      {"publicSsh": 1}
      """
    When the fleet configuration is read
    Then it is refused at "$.worker.exposure"

  Scenario: The schema an editor checks fleet.json with accepts what the parser accepts
    Given the fleet configuration of the example
    And the worker policy declares the exposure:
      """
      {"publicSsh": false, "publicPorts": [{"protocol": "udp", "port": 51820}], "otherListeners": "fail"}
      """
    And "worker-one" declares the exposure:
      """
      {"publicSsh": true}
      """
    When the fleet configuration is read
    Then the parser accepts it
    And the schema accepts it
